/*
 * Copyright 2019-2023 Ilker Temir <ilker@ilkertemir.com>
 * Copyright 2023-2024 Saillogger LLC <info@saillogger.com>
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const POLL_INTERVAL = 5               // Poll every N seconds
const SUBMIT_INTERVAL = 1             // Submit to server every N minutes
const AIS_SUBMISSION_INTERVAL = 5     // Submit AIS data every N minutes
const SEND_METADATA_INTERVAL = 1      // Submit to API every N hours
const CONFIGURATION_PORT = 1977	      // Port number for configuration
const API_BASE = 'https://saillogger.com/api/v1/collector'

const fs = require('fs')
const filePath = require('path')
const request = require('request')
const sqlite3 = require('sqlite3')
const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors')
const { machineId, machineIdSync } = require('node-machine-id');
const package = require('./package.json');
const userAgent = `Saillogger plugin v${package.version}`;

module.exports = function(app) {
  var plugin = {};
  var unsubscribes = [];
  var submitProcess;
  var aisSubmissionProcess;
  var sendMetadataProcess;
  var metdataSubmitted = false;
  var db;
  var uuid;
  var gpsSource;
  var configuration;
  var monitoringConfiguration;
  var updateLastCalled = Date.now();
  var lastSuccessfulUpdate;
  var position;
  var speedOverGround;
  var maxSpeedOverGround;
  var courseOverGroundTrue;
  var windSpeedApparent = 0;
  var angleSpeedApparent;
  var previousSpeeds = [];
  var previousCOGs = [];
  var deviceSerialNumber;
  var aisTarget = {};
  const selfMmsi = app.getSelfPath('mmsi');

  plugin.id = "signalk-saillogger";
  plugin.name = "Saillogger";
  plugin.description = "Saillogger plugin for Signal K";

  plugin.start = function(options) {
    configuration = options;
    startPlugin(options);
  }

  plugin.stop = function() {
    app.debug(`Stopping the plugin`);
    clearInterval(sendMetadataProcess);
    clearInterval(submitProcess);
    clearInterval(aisSubmissionProcess);
    if (db) {
      db.close();
    }
  };

  plugin.schema = {
    type: 'object',
    required: ['uuid'],
    properties: {
      uuid: {
        type: "string",
        title: "Collector ID (obtain free from https://saillogger.com/boats/)"
      },
      source: {
        type: "string",
        title: "GPS source (leave empty if unsure; details at https://saillogger.com/support/)"
      }
    }
  }

  function startPlugin(options) {
    let platform = findPlatform();
    app.debug(`Running on ${platform}`);

    if (!options.uuid) {
      if ( isVenusOS() ) {
        // We spin up the automatic configuration interface for Venus OS only
        app.debug('Collector ID is required, going into configuration mode');
        setupWebServerForConfiguration();
      }
      return
    } else {
      app.debug(`Starting the plugin with collector ID ${options.uuid}`);
    }
  

    uuid = options.uuid;
    gpsSource = options.source;
    deviceSerialNumber = machineIdSync();

    app.setPluginStatus('Saillogger started. Please wait for a status update.');

    let dbFile= filePath.join(app.getDataDirPath(), 'saillogger_v2.sqlite3');
    db = new sqlite3.Database(dbFile);
    db.run('CREATE TABLE IF NOT EXISTS buffer(ts REAL,' +
           '                                 latitude REAL,' +
           '                                 longitude REAL,' +
           '                                 speedOverGround REAL,' +
           '                                 courseOverGroundTrue REAL,' +
           '                                 windSpeedApparent REAL,' +
           '                                 angleSpeedApparent REAL,' +
           '                                 additionalData TEXT)');
    db.run('CREATE TABLE IF NOT EXISTS configuration(id INTEGER PRIMARY KEY,' +
           '                                         config TEXT)');
    
    getConfiguration();
    sendMetadata();

    let subscription = {
      context: 'vessels.self',
      subscribe: [{
        path: 'navigation.position',
        period: POLL_INTERVAL * 1000
      }, {
        path: 'navigation.speedOverGround',
        period: POLL_INTERVAL * 1000
      }, {
        path: 'navigation.courseOverGroundTrue',
        period: POLL_INTERVAL * 1000
      }, {
        path: 'environment.wind.speedApparent',
        period: POLL_INTERVAL * 1000
      }, {
        path: 'environment.wind.angleApparent',
        period: POLL_INTERVAL * 1000
      }]
    };

    app.subscriptionmanager.subscribe(subscription, unsubscribes, function() {
      app.error('Subscription error');
    }, data => processDelta(data));

    submitDataToServer();
    updatePluginStatus();
    // Send metadata and AIS targets after a warm-up period
    setTimeout( function() {
      sendMetadata();
      sendAisTargets();
    }, 60 * 1000);

    sendMetadataProcess = setInterval( function() {
      sendMetadata();
    }, SEND_METADATA_INTERVAL * 60 * 60 * 1000);

    submitProcess = setInterval( function() {
      submitDataToServer();
      updatePluginStatus();
    }, SUBMIT_INTERVAL * 60 * 1000);

    aisSubmissionProcess = setInterval( function() {
      sendAisTargets();
    }, AIS_SUBMISSION_INTERVAL * 60 * 1000);

  }

  function updatePluginStatus() {
    db.get('SELECT COUNT(*) AS count FROM buffer', function(err, row) {
        if (err) {
            app.debug('Error querying buffer count:', err);
        } else {
            let message;
            if (row.count == 1) {
                message = `${row.count} entry in the queue,`;
            } else {
                message = `${row.count} entries in the queue,`;
            }
            if (lastSuccessfulUpdate) {
                let since = timeSince(lastSuccessfulUpdate);
                message += ` last connection to the server was ${since} ago.`;
            } else {
                message += ` no successful connection to the server since restart.`;
            }
            app.setPluginStatus(message);
        }
    });
  }

  function isVenusOS() {
    return (fs.existsSync('/etc/venus'));
  }

  function getVictronDeviceModel() {
    if (!isVenusOS()) {
      return (null);
    }
    var name;
    try {
      name = require('child_process').execSync('/usr/bin/product-name', {stdio : 'pipe' }).toLocaleString()
    } catch {
      name = null;
    }
    return name;
  }

  function setupWebServerForConfiguration() {
    var expressApp = express();
    var corsOptions = {
      origin: 'http://cdn.saillogger.com',
      optionsSuccessStatus: 200
    }
    expressApp.use(cors(corsOptions));
    expressApp.use(bodyParser.urlencoded({
      extended: true,
    }));

    expressApp.post('/registerCollector', function (req, res, next) { 
      const model = getVictronDeviceModel();
      if (configuration.uuid) {
        app.debug(`Received a configuration request but collector id already set, ignoring`);
        return res.json({
          success: false,
	        reason: 'CollectorID already set',
	        model: model
        });
      }
      let collectorId = req.body.collectorId;
      app.debug(`Received request to configure collector with ${collectorId}`);
      if (!collectorId) {
        res.json({
          success: false,
          reason: 'No CollectorID',
          model: model
        });
      } else {
        configuration.uuid = collectorId;
        app.savePluginOptions(configuration, () => {
          app.debug(`Collector ID saved (${collectorId}), restarting the plugin`);
          // Start the plugin with proper collectorId now
          startPlugin(configuration);
          res.json({
            success: true,
            reason: null,
            model: model
          });
        });
      }
    })

    expressApp.listen(CONFIGURATION_PORT, function () {
      app.debug(`Configuration web server listening on port ${CONFIGURATION_PORT}`);
    })
  }

  // Find the platform we are running on
  function findPlatform() {
    if ( isVenusOS() ) {
      let platform = `Victron ${getVictronDeviceModel()}`;
      return platform;
    }

    let platform = '';
    try {
      const cpuInfo = fs.readFileSync('/proc/cpuinfo', { encoding: 'utf8', flag: 'r' });
      let re = /Model\s*:\s*([^\n]+)/i;
      let found = cpuInfo.match(re);
      if (found) {
        platform += found[1];
      }
      re = /Model Name\s*:\s*([^\n]+)/i;
      found = cpuInfo.match(re);
      if (found) {
        platform += ' ' + found[1];
      } 
    } catch (err) {
      app.debug('Cannot find /proc/cpuinfo');
    }
    return platform;
  }

  function saveConfiguration() {
    config = JSON.stringify(monitoringConfiguration);
    db.run('INSERT OR REPLACE INTO configuration(id, config) VALUES(1, ?)', [config], function(err) {
      if (err) {
        app.debug(`Failed to store configuration locally ${err}`);
      } else {
        app.debug('Configuration stored locally');
      }
    });
  }

  function loadConfiguration() {
    db.get('SELECT * FROM configuration WHERE id=1', function(err, row) {
      if (err) {
        app.debug('Failed to load configuration');
      } else {
        if (row) {
          app.debug('Configuration loaded from local storage');
          monitoringConfiguration = JSON.parse(row.config);
        } else {
          app.debug('No locally stored configuration found');
        }
      }
    });
  }

  function getConfiguration() {
    app.debug('Retrieving monitoring configuration');
    let options = {
      uri: API_BASE + '/monitoring/' + uuid + '/configuration',
      method: 'GET',
      headers: {
        'User-Agent': userAgent,
      }
    };
    request.get(options, function (error, response, body) {
      if (!error && response.statusCode == 200) {
        monitoringConfiguration = JSON.parse(body);
        app.debug(`Monitoring configuration: ${JSON.stringify(monitoringConfiguration)}`);
        saveConfiguration();
      } else {
        app.debug('Failed to get monitoring configuration, trying to load from local storage');
        loadConfiguration();
      }
    });
  }

  function sendMetadata() {
    function getAllKeys(obj, parentKey = '', result = []) {
      for (let key in obj) {
        if (obj.hasOwnProperty(key)) {
          const newKey = parentKey ? `${parentKey}.${key}` : key;
          if (obj[key] !== null && typeof obj[key] === 'object') {
            if (obj[key]['$source']) {
              if (obj[key].value !== null && typeof(obj[key].value)=== 'number') {
                result.push({
                  key: newKey,
                  unit: obj[key]?.meta?.units ?? null
                });
              }
            } else {
              getAllKeys(obj[key], newKey, result);
            }
          }
        }
      }
      return result;
    }

    let self = app.getPath('self');
    let dataModel = app.getPath(self);
    let availableKeys=getAllKeys(dataModel);

    let data = {
      name: app.getSelfPath('name'),
      mmsi: selfMmsi,
      length: app.getSelfPath('design.length.value.overall'),
      beam:  app.getSelfPath('design.beam.value'),
      height:  app.getSelfPath('design.airHeight.value'),
      ship_type: app.getSelfPath('design.aisShipType.value.id'),
      version: package.version,
      signalk_version: app.config.version,
      platform: findPlatform(),
      serial_number: deviceSerialNumber,
      configuration: configuration,
      available_keys: availableKeys
    }

    let postData = {
      uri: API_BASE + '/' + uuid + '/update',
      method: 'POST',
      json: JSON.stringify(data),
      headers: {
        'User-Agent': userAgent,
      }
    };

    app.debug (`Metadata: ${JSON.stringify(data)}`);
    request(postData, function (error, response, body) {
      if (!error && response.statusCode == 200) {
        app.debug('Successfully submitted metadata');
        lastSuccessfulUpdate = Date.now();
        metdataSubmitted = true;
      } else {
        app.debug('Metadata submission failed');
      }
    });
  }

  function refreshAisData() {
    function getVesselDetails(vessel) {
      return {
        beam: vessel.design?.beam?.value,
        length: vessel.design?.length?.value,
        shipType: vessel.design?.aisShipType?.value.id,
        ais: {
          class: vessel.sensors?.ais?.class?.value,
          fromBow: vessel.sensors?.ais?.fromBow?.value,
          fromCenter: vessel.sensors?.ais?.fromCenter?.value,
        },
        navigation: {
          state: vessel.navigation?.specialManeuver?.value,
          rateOfTurn: vessel.navigation?.rateOfTurn?.value,
          specialManeuver: vessel.navigation?.specialManeuver?.value,
          destination: vessel.navigation?.destination?.commonName?.value,
        },
        registrations: vessel.registrations?.value
      }
    }
    let vessels = app.getPath('vessels');
    let detectedTargets = [];
    for (let key in vessels) {
      let vessel=vessels[key];
      if ((!vessel.mmsi) || (vessel.mmsi == selfMmsi)) {
        continue;
      }
      if (!("navigation" in vessel) || !("position" in vessel.navigation)) {
        continue;
      }
      detectedTargets.push(vessel.mmsi);
      let position = vessel.navigation.position.value;
      let date = new Date(vessel.navigation.position.timestamp);
      let timeStamp = Math.round(date.getTime()/1000);
      let heading= vessel.navigation.courseOverGroundTrue?.value;
      if (heading) {
        heading = Math.round(heading *  57.295779513); // Convert to degrees
      } else {
        heading = vessel.navigation.headingTrue?.value;
        if (heading) {
          heading = Math.round(heading *  57.295779513); // Convert to degrees
        } else {
          heading = 0;
        }
      }

      let speed=vessel.navigation.speedOverGround?.value;
      if (speed) {
        speed = speed*1.94384;
        if (speed < 10) {
          speed = Math.round(speed*10)/10;
        } else {
          speed = Math.round(speed);
        }
      } else {
        speed = 0;
      }

      let shipType = vessel.design?.aisShipType?.value.name;
      if (!shipType) {
        shipType = 'Unknown';
      }

      let name;
      if (!vessel.name) {
        name = "Unknown";
      } else {
        name = vessel.name;
      }

      if (!(vessel.mmsi in aisTarget)) {
        app.debug(`Inserting AIS vessel ${vessel.mmsi} details`);
        aisTarget[vessel.mmsi] = {
          counter: 0,
          updated: timeStamp,
          name: name,
          position: position,
          speed: speed,
          heading: heading,
          type: shipType,
          vessel: getVesselDetails(vessel)
        }
      } else if (aisTarget[vessel.mmsi].updated != timeStamp) {
        app.debug(`Updating AIS vessel ${vessel.mmsi} details`);
        aisTarget[vessel.mmsi].updated = timeStamp;
        aisTarget[vessel.mmsi].name = name;
        aisTarget[vessel.mmsi].position = position;
        aisTarget[vessel.mmsi].speed = speed;
        aisTarget[vessel.mmsi].heading = heading;
        aisTarget[vessel.mmsi].type = shipType;
        if (aisTarget[vessel.mmsi].counter++ == 30) {
          app.debug(`Sending full vessel details for ${vessel.mmsi}`);
          aisTarget[vessel.mmsi].counter = 0;
          aisTarget[vessel.mmsi].vessel = getVesselDetails(vessel);
        } else {
          delete aisTarget[vessel.mmsi].vessel;
        }  
      } else {
        app.debug(`AIS vessel ${vessel.mmsi} details not changed`);
      }
      
    }
    // Remove vessels that moved out of range
    for (let mmsi in aisTarget) {
      if (!detectedTargets.includes(mmsi)) {
        delete aisTarget[mmsi];
      }
    }
  }

  function updateDatabase() {
    let ts = Date.now();
    updateLastCalled = ts;

    if ((!position) || (!position.changedOn)) {
      return
    }

    let monitoringDataInJson = null;
    if (monitoringConfiguration) {
      let monitoringData = getMonitoringData(monitoringConfiguration);
      monitoringDataInJson = JSON.stringify(monitoringData);
    } else {
      getConfiguration();
      monitoringDataInJson = null;
    }
    let values = [position.changedOn, position.latitude, position.longitude,
                  maxSpeedOverGround, courseOverGroundTrue, windSpeedApparent,
                  angleSpeedApparent, monitoringDataInJson];

    db.run('INSERT INTO buffer VALUES(?, ?, ?, ?, ?, ?, ?, ?)', values, function(err) {
      windSpeedApparent = 0;
      maxSpeedOverGround = 0;
    });
    position.changedOn = null;
  }

  function submitDataToServer() {
    db.all('SELECT * FROM buffer ORDER BY ts LIMIT 60', function(err, data) {
      if (err) {
        app.debug('Error querying buffer:', err);
        return;
      }
      if (!data) {
        app.debug('No data in the buffer');
        return;
      }
      if (data.length == 0) {
        app.debug('Local cache is empty, sending an empty ping');
      }

      let httpOptions = {
        uri: API_BASE + '/' + uuid + '/push',
        method: 'POST',
        json: JSON.stringify(data),
        headers: {
          'User-Agent': userAgent,
        }
      };

      request(httpOptions, function (error, response, body) {
        if (!error && response.statusCode == 200) {
          let lastTs = body.processedUntil;
          app.debug(`Successfully submitted ${data.length} data record(s)`);
          if (body.refreshMetadata) {
            app.debug('Server requested metadata refresh');
            sendMetadata();
          }
          if (monitoringConfiguration && (body.configurationVersion > monitoringConfiguration.version)) {
            app.debug(`New monitoring configuration available (v${body.configurationVersion})`);
            getConfiguration();
          }
          db.run('DELETE FROM buffer where ts <= ' + lastTs, function(err) {
            lastSuccessfulUpdate = Date.now();
            db.get('SELECT COUNT(*) AS count FROM buffer', function(err, row) {
                if (err) {
                    app.debug('Error querying buffer count:', err);
                } else if (row.count > 1) {
                    app.debug(`Cache not fully flushed, ${row.count} record(s) left. Continuing...`);
                    submitDataToServer();
                }
            });
          });
        } else if (!error && response.statusCode == 204) {
          app.debug('Server responded with HTTP-204');
        } else {
          app.debug(`Connection to the server failed, retry in ${SUBMIT_INTERVAL} min`);
        }
      });
    });
  }

  function getKeyValue(key, maxAge) {
    let data = app.getSelfPath(key);
    if (!data) {
      return null;
    }
    let now = new Date();
    let ts = new Date(data.timestamp);
    let age = (now - ts) / 1000;
    if (age <= maxAge) {
      return data.value
    } else {
      return null;
    }
  }

  function sendAisTargets() {
    if (!monitoringConfiguration) {
      app.debug('Monitoring configuration not available yet');
      return
    }
    if (!monitoringConfiguration.sendAisTargets) {
      app.debug('AIS target submission is disabled');
      return
    }
    refreshAisData();
    let data = {
      aisTargets: aisTarget,
    }

    let httpOptions = {
      uri: API_BASE + '/ais/' + uuid + '/push',
      method: 'POST',
      json: JSON.stringify(data),
      headers: {
        'User-Agent': userAgent,
      }
    };

    app.debug(`Sending AIS data for ${Object.keys(data).length} vessels`);
    request(httpOptions, function (error, response, responseData) {
      if (!error && response.statusCode == 200) {
        app.debug(`AIS data successfully submitted`);
      } else {
        app.debug('Submission of AIS data failed');
      }
    });
  }

  function getMonitoringData(configuration) {
      let data = {
        sog: metersPerSecondToKnots(getKeyValue('navigation.speedOverGround', 60)),
        cog: radiantToDegrees(getKeyValue('navigation.courseOverGroundTrue', 60)),
        heading: radiantToDegrees(getKeyValue('navigation.headingTrue', 60)),
        anchor: {
          position: getKeyValue('navigation.anchor.position', 60),
          radius: getKeyValue('navigation.anchor.maxRadius', 60)
        },
        water: {
          depth: getKeyValue(configuration.depthKey, 10),
          temperature: kelvinToCelsius(getKeyValue(configuration.waterTemperatureKey, 90))
        },
        wind: {
          speed: metersPerSecondToKnots(getKeyValue(configuration.windSpeedKey, 90)),
          direction: radiantToDegrees(getKeyValue(configuration.windDirectionKey, 90))
        },
        pressure: pascalToHectoPascal(getKeyValue(configuration.pressureKey, 90)),
        temperature: {
          inside: kelvinToCelsius(getKeyValue(configuration.insideTemperatureKey, 90)),
          outside: kelvinToCelsius(getKeyValue(configuration.outsideTemperatureKey, 90))
        },
        humidity: {
          inside: floatToPercentage(getKeyValue(configuration.insideHumidityKey, 90)),
          outside: floatToPercentage(getKeyValue(configuration.outsideHumidityKey, 90))
        },
        battery: {
          voltage: getKeyValue(configuration.batteryVoltageKey, 60),
          charge: floatToPercentage(getKeyValue(configuration.batteryChargeKey, 60))
        }
      };
  
      for (let i = 0; i < configuration.additionalDataKeys.length; i++) {
        let key = configuration.additionalDataKeys[i];
        let value = getKeyValue(key, 60);
        if (value) {
          data[key] = value;
        }
      }
  
      return data;
    }

  function timeSince(date) {
    var seconds = Math.floor((new Date() - date) / 1000);
    var interval = seconds / 31536000;
    if (interval > 1) {
      return Math.floor(interval) + " years";
    }
    interval = seconds / 2592000;
    if (interval > 1) {
      return Math.floor(interval) + " months";
    }
    interval = seconds / 86400;
    if (interval > 1) {
      return Math.floor(interval) + " days";
    }
    interval = seconds / 3600;
    if (interval > 1) {
      return Math.floor(interval) + " hours";
    }
    interval = seconds / 60;
    if (interval > 1) {
      return Math.floor(interval) + " minutes";
    }
    return Math.floor(seconds) + " seconds";
  }

  function radiantToDegrees(rad) {
    if (rad == null) {
      return null;
    }
    return Math.round(rad * 57.2958 * 10) / 10;
  }

  function metersPerSecondToKnots(ms) {
    if (ms == null) {
      return null;
    }
    return Math.round(ms * 1.94384 * 10) / 10;
  }

  function kelvinToCelsius(deg) {
    if (deg == null) {
      return null;
    }
    return Math.round((deg - 273.15) * 10) / 10;
  }

  function floatToPercentage(val) {
    if (val == null) {
      return null;
    }
    return val * 100;
  }

  function pascalToHectoPascal(pa) {
    if (pa == null) {
      return null;
    }
    return Math.round(pa/100*10)/10;
  }

  function processDelta(data) {
    let dict = data.updates[0].values[0];
    let path = dict.path;
    let value = dict.value;
    let timePassed = Date.now() - updateLastCalled;

    switch (path) {
      case 'navigation.position':
        let source = data.updates[0]['$source'];
        if ((gpsSource) && (source != gpsSource)) {
          app.debug(`Skipping position from GPS resource ${source}`);
	        break;
	      }
        if (timePassed >= SUBMIT_INTERVAL * 60 * 1000) {
          position = value;
          position.changedOn = Date.now();
          updateDatabase();
        }
        break;
      case 'navigation.speedOverGround':
        // Keep the previous 3 values
        speedOverGround = metersPerSecondToKnots(value);
        maxSpeedOverGround = Math.max(maxSpeedOverGround, speedOverGround)
        previousSpeeds.unshift(speedOverGround);
        previousSpeeds = previousSpeeds.slice(0, 3);
        break;
      case 'navigation.courseOverGroundTrue':
        // Keep the previous 3 values
        courseOverGroundTrue = radiantToDegrees(value);
        previousCOGs.unshift(courseOverGroundTrue);
        previousCOGs = previousCOGs.slice(0, 6);
        break;
      case 'environment.wind.speedApparent':
        windSpeedApparent = Math.max(windSpeedApparent, metersPerSecondToKnots(value));
        break;
      case 'environment.wind.angleApparent':
        angleSpeedApparent = radiantToDegrees(value);
        break;
      default:
        app.error('Unknown path: ' + path);
    }
  }

  return plugin;
}
