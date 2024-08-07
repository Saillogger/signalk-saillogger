/*
 * Copyright 2019-2024 Ilker Temir <ilker@ilkertemir.com>
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
const SUBMIT_INTERVAL = 5             // Submit to server every N minutes
const MONITORING_SUBMIT_INTERVAL = 1  // Submit to API every N minutes
const SEND_METADATA_INTERVAL = 1      // Submit to API every N hours
const MIN_DISTANCE = 0.50             // Update database if moved X miles
const DB_UPDATE_MINUTES = 15          // Update database every N minutes (worst case)
const DB_UPDATE_MINUTES_MOVING = 5    // Update database every N minutes while moving
const SPEED_THRESHOLD = 1             // Speed threshold for moving (knots)
const MINIMUM_TURN_DEGREES = 45       // Update database if turned more than N degrees
const CONFIGURATION_PORT = 1977	      // Port number for configuration
const API_BASE = 'https://saillogger.com/api/v1/collector'

const fs = require('fs')
const filePath = require('path')
const request = require('request')
const sqlite3 = require('sqlite3')
const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors')
const serialNumber = require('serial-number');
const package = require('./package.json');
const userAgent = `Saillogger plugin v${package.version}`;

module.exports = function(app) {
  var plugin = {};
  var unsubscribes = [];
  var submitProcess;
  var monitoringProcess;
  var sendMetadataProcess;
  var metdataSubmitted = false;
  var statusProcess;
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
    clearInterval(monitoringProcess);
    clearInterval(statusProcess);
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

    app.setPluginStatus('Saillogger started. Please wait for a status update.');

    serialNumber(function (err, value) {
      deviceSerialNumber = value;
      sendMetadata(options);
    });

    let dbFile= filePath.join(app.getDataDirPath(), 'saillogger.sqlite3');
    db = new sqlite3.Database(dbFile);
    db.run('CREATE TABLE IF NOT EXISTS buffer(ts REAL,' +
           '                                 latitude REAL,' +
           '                                 longitude REAL,' +
           '                                 speedOverGround REAL,' +
           '                                 courseOverGroundTrue REAL,' +
           '                                 windSpeedApparent REAL,' +
           '                                 angleSpeedApparent REAL)');
    
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

    // Send a metadata refresh a minute after start and then every hour
    setTimeout( function() {
      // This is timed to make sure we have captured available data keys
      sendMetadata(options);
    }, 60 * 1000);

    sendMetadataProcess = setInterval( function() {
      sendMetadata(options);
    }, SEND_METADATA_INTERVAL * 60 * 60 * 1000);

    submitProcess = setInterval( function() {
      submitDataToServer();
    }, SUBMIT_INTERVAL * 60 * 1000);

    monitoringProcess = setInterval( function() {
      if (monitoringConfiguration) {
        sendMonitoringData(monitoringConfiguration);
      } else {
        app.debug('Monitoring configuration not set');
        getMonitoringConfiguration();
      }
    }, MONITORING_SUBMIT_INTERVAL * 60 * 1000);

    statusProcess = setInterval( function() {
      db.all('SELECT * FROM buffer ORDER BY ts', function(err, data) {
        let message;
        if (data.length == 1) {
          message = `${data.length} entry in the queue,`;
        } else {
          message = `${data.length} entries in the queue,`;
        }
        if (lastSuccessfulUpdate) {
          let since = timeSince(lastSuccessfulUpdate);
          message += ` last connection to the server was ${since} ago.`;
        } else {
          message += ` no successful connection to the server since restart.`;
        }
        app.setPluginStatus(message);
      })
    }, 31*1000);
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

  function getMonitoringConfiguration() {
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
        sendMonitoringData(monitoringConfiguration);
      } else {
        app.debug('Failed to get monitoring configuration');
      }
    });
  }

  function sendMetadata(options) {
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

    if (metdataSubmitted == true) {
      app.debug('Metada already submitted, refreshing');
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
        app.debug('Successfully sent metadata to the server');
        lastSuccessfulUpdate = Date.now();
        getMonitoringConfiguration();
        submitDataToServer();
        metdataSubmitted = true;
      } else {
        app.debug('Metadata submission to the server failed');
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

    let values = [position.changedOn, position.latitude, position.longitude,
                  maxSpeedOverGround, courseOverGroundTrue, windSpeedApparent,
                  angleSpeedApparent];

    db.run('INSERT INTO buffer VALUES(?, ?, ?, ?, ?, ?, ?)', values, function(err) {
      windSpeedApparent = 0;
      maxSpeedOverGround = 0;
    });
    position.changedOn = null;
  }

  function submitDataToServer() {
    db.all('SELECT * FROM buffer ORDER BY ts LIMIT 250', function(err, data) {
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
          db.run('DELETE FROM buffer where ts <= ' + lastTs);
          lastSuccessfulUpdate = Date.now();
          app.debug(`Successfully sent ${data.length} record(s) to the server`);
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

  /*
    We keep Monitoring as an independent process. This doesn't have a cache.
  */
  function sendMonitoringData(options) {
    if (options.sendAisTargets === true) {
      refreshAisData();
    } else {
      aisTarget = {};
    }

    let position = getKeyValue('navigation.position', 6*60*60);
    if (position == null) {
      // This is odd, let's debug
      let data = app.getSelfPath('navigation.position');
      if (!data) {
        app.debug('No navigation.position for self.');
        return;
      }
      let now = new Date();
      let dataTs = new Date(data.timestamp);
      app.debug(`No position data, not sending monitoring information (${now}, ${dataTs})`);
      return;
    }

    let data = {
      position: position,
      sog: metersPerSecondToKnots(getKeyValue('navigation.speedOverGround', 60)),
      cog: radiantToDegrees(getKeyValue('navigation.courseOverGroundTrue', 60)),
      heading: radiantToDegrees(getKeyValue('navigation.headingTrue', 60)),
      anchor: {
        position: getKeyValue('navigation.anchor.position', 60),
        radius: getKeyValue('navigation.anchor.maxRadius', 60)
      },
      water: {
        depth: getKeyValue(options.depthKey, 10),
        temperature: kelvinToCelsius(getKeyValue(options.waterTemperatureKey, 90))
      },
      wind: {
        speed: metersPerSecondToKnots(getKeyValue(options.windSpeedKey, 90)),
        direction: radiantToDegrees(getKeyValue(options.windDirectionKey, 90))
      },
      pressure: pascalToHectoPascal(getKeyValue(options.pressureKey, 90)),
      temperature: {
        inside: kelvinToCelsius(getKeyValue(options.insideTemperatureKey, 90)),
        outside: kelvinToCelsius(getKeyValue(options.outsideTemperatureKey, 90))
      },
      humidity: {
        inside: floatToPercentage(getKeyValue(options.insideHumidityKey, 90)),
        outside: floatToPercentage(getKeyValue(options.outsideHumidityKey, 90))
      },
      battery: {
        voltage: getKeyValue(options.batteryVoltageKey, 60),
        charge: floatToPercentage(getKeyValue(options.batteryChargeKey, 60))
      },
      aisTargets: aisTarget
    }

    for (let i=0;i < options.additionalDataKeys.length;i++) {
      let key = options.additionalDataKeys[i];
      let value = getKeyValue(key, 60);
      if (value) {
        data[key] = value;
      }
    }

    let httpOptions = {
      uri: API_BASE + '/monitoring/' + uuid + '/push',
      method: 'POST',
      json: JSON.stringify(data),
      headers: {
        'User-Agent': userAgent,
      }
    };

    app.debug(`Sending monitoring data: ${JSON.stringify(data)}`);
    request(httpOptions, function (error, response, responseData) {
      if (!error && response.statusCode == 200) {
        app.debug(`Monitoring data successfully submitted (Server configuration: v${responseData.configuration_version})`);
        if (responseData.configuration_version > options.version){
          app.debug(`New monitoring configuration available (v${responseData.configuration_version})`);
          getMonitoringConfiguration();
        }
      } else {
        app.debug('Submission of monitoring data failed');
      }
    });
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

  function calculateDistance(lat1, lon1, lat2, lon2) {
    if ((lat1 == lat2) && (lon1 == lon2)) {
      return 0;
    }
    else {
      var radlat1 = Math.PI * lat1/180;
      var radlat2 = Math.PI * lat2/180;
      var theta = lon1-lon2;
      var radtheta = Math.PI * theta/180;
      var dist = Math.sin(radlat1) * Math.sin(radlat2) + Math.cos(radlat1) * Math.cos(radlat2) * Math.cos(radtheta);
      if (dist > 1) {
          dist = 1;
      }
      dist = Math.acos(dist);
      dist = dist * 180/Math.PI;
      dist = dist * 60 * 1.1515;
      dist = dist * 0.8684; // Convert to Nautical miles
      return dist;
    }
  }

  function vesselMadeSignificantTurn() {
    /*
      Returns true if vessel has made a significant turn
    */

    if (previousCOGs.length < 6) {
      return (false);
    }
    let delta = previousCOGs[5] - previousCOGs[0];
    if (Math.abs(delta) > MINIMUM_TURN_DEGREES) {
      app.debug(`Updating database, vessel turned ${delta} degrees`);
      return (true);
    } else {
      return (false);
    }
  }

  function vesselSlowedDownOrSpeededUp(threshold) {
    /*
      Returns true if vessel has gone above or below a speed threshold
    */

    if ((speedOverGround <= threshold) &&
        (previousSpeeds.every(el => el > threshold)))  {
      app.debug(`Updating database, vessel slowed down to ${speedOverGround} kt`);
      return (true);
    }
    if ((speedOverGround > threshold) &&
        (previousSpeeds.every(el => el <= threshold))) {
      app.debug(`Updating database, vessel speeded up to ${speedOverGround} kt`);
      return (true);
    }
    return (false);
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
        if (position) {
          let distance = calculateDistance(position.latitude,
                                           position.longitude,
                                           value.latitude,
                                           value.longitude);
          let timeBetweenPositions = Date.now() - position.changedOn;
          if ((timeBetweenPositions <= 2 * 60 * 1000) && (distance >= 5)) {
                  app.error(`Erroneous position reading. ` +
                      `Moved ${distance} miles in ${timeBetweenPositions/1000} seconds. ` +
                            `Ignoring the position: ${position.latitude}, ${position.longitude}`);
            return;
          }

          position.changedOn = Date.now();
     
          // Don't push updates more than once every 1 minute
          if (timePassed >= 60 * 1000) {
            // updateDatabase() is split to multiple if conditions for better debug messages

            // Want submissions every DB_UPDATE_MINUTES at the very least
	          if (timePassed >= DB_UPDATE_MINUTES * 60 * 1000) {
              app.debug(`Updating database, ${DB_UPDATE_MINUTES} min passed since last update`);
              position = value;
              position.changedOn = Date.now();
              updateDatabase();
            }

            // Or a meaningful time passed while moving
            else if (
              (speedOverGround >= SPEED_THRESHOLD) &&
              (timePassed >= DB_UPDATE_MINUTES_MOVING * 60 * 1000)
            ) {
              app.debug(`Updating database, ${DB_UPDATE_MINUTES_MOVING} min passed while moving`);
              position = value;
              position.changedOn = Date.now();
              updateDatabase();
            }

            // Or we moved a meaningful distance
            else if (distance >= MIN_DISTANCE) {
              app.debug(`Updating database, moved ${distance} miles`);
              position = value;
              position.changedOn = Date.now();
              updateDatabase();
            }

            // Or we made a meaningful change of course while moving
            else if (
              (speedOverGround >= SPEED_THRESHOLD) && (vesselMadeSignificantTurn())
            ) {
              position = value;
              position.changedOn = Date.now();
              updateDatabase();
            }

            // Or the boat has slowed down or speeded up
            else if (
                 (vesselSlowedDownOrSpeededUp(SPEED_THRESHOLD)) ||
                 (vesselSlowedDownOrSpeededUp(SPEED_THRESHOLD*2)) ||
                 (vesselSlowedDownOrSpeededUp(SPEED_THRESHOLD*3))
               ) {
              position = value;
              position.changedOn = Date.now();
              updateDatabase();
            }
          }
        } else {
          position = value;
          position.changedOn = Date.now();
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
