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
const API_BASE = 'https://saillogger.com/api/v1/collector'
const DSC_PGN = 129808                // NMEA 2000 DSC Call Information
const DSC_MAX_ATTEMPTS = 3            // DSC alert delivery attempts before dropping
const DSC_RETRY_INTERVAL = 15         // Seconds between DSC delivery attempts
const DSE_PAIR_WINDOW = 2             // Minutes to pair a DSE refinement with its DSC call

const fs = require('fs')
const filePath = require('path')
const request = require('request')
const { BufferStore, ConfigStore } = require('./lib/storage')
const { parseDsc, parseDse, refinePosition, normalizePgn129808 } = require('./lib/dsc')
const { machineId, machineIdSync } = require('node-machine-id');
const package = require('./package.json');
const userAgent = `Saillogger plugin v${package.version}`;

module.exports = function(app) {
  var plugin = {};
  var unsubscribes = [];
  var queueLength = 0;
  var aisSubmissionProcess;
  var sendMetadataProcess;
  var submitDataProcess;
  var metdataSubmitted = false;
  var bufferStore;
  var configStore;
  var uuid;
  var gpsSource;
  var configuration;
  var monitoringConfiguration;
  var retrieveMonitoringConfigInProgress;
  var updateLastCalled;
  var dBInsertInProgress = false;
  var lastSuccessfulUpdate;
  var submitLastCalled;
  var position;
  var speedOverGround;
  var maxSpeedOverGround;
  var portEngineHours;
  var starboardEngineHours;
  var courseOverGroundTrue;
  var windSpeedApparent = 0;
  var angleSpeedApparent;
  var previousSpeeds = [];
  var previousCOGs = [];
  var deviceSerialNumber;
  var aisTarget = {};
  var dscStarted = false;
  var dscParsersRegistered = false;
  var recentDscCalls = [];
  var dscRetryTimers = [];
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
    clearInterval(aisSubmissionProcess);
    clearInterval(submitDataProcess);
    dscStarted = false;
    dscRetryTimers.forEach(clearTimeout);
    dscRetryTimers = [];
    recentDscCalls = [];
    app.removeListener('N2KAnalyzerOut', handleDscPgn);
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
      app.debug('Collector ID is required');
      return
    } else {
      app.debug(`Starting the plugin with collector ID ${options.uuid}`);
    }
  

    uuid = options.uuid;
    gpsSource = options.source;
    deviceSerialNumber = machineIdSync();

    app.setPluginStatus('Saillogger started. Please wait 60 seconds for a status update.');

    const dataDir = app.getDataDirPath();
    bufferStore = new BufferStore(filePath.join(dataDir, 'saillogger_buffer.ndjson'));
    configStore = new ConfigStore(filePath.join(dataDir, 'saillogger_config.json'));

    const legacySqlitePath = filePath.join(dataDir, 'saillogger_v3.sqlite3');
    if (fs.existsSync(legacySqlitePath)) {
      app.debug(`Legacy SQLite cache found at ${legacySqlitePath}; leaving it untouched.`);
    }
    
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
      }, {
        path: 'propulsion.port.runTime',
        period: POLL_INTERVAL * 1000
      }, {
        path: 'propulsion.starboard.runTime',
        period: POLL_INTERVAL * 1000
      }]
    };

    app.subscriptionmanager.subscribe(subscription, unsubscribes, function() {
      app.error('Subscription error');
    }, data => processDelta(data));

    // DSC calls are event-driven and safety-critical: parse and forward each
    // one immediately rather than buffering. Always on; both NMEA 0183
    // ($CDDSC/$CDDSE) and NMEA 2000 (PGN 129808) are handled.
    dscStarted = true;
    // SignalK has no API to unregister an nmea0183sentenceParser, so register
    // the 0183 parsers only once per process lifetime; a restart would otherwise
    // stack duplicate copies that each forward the same call.
    if (!dscParsersRegistered) {
      app.emitPropertyValue('nmea0183sentenceParser', { sentence: 'DSC', parser: handleDscSentence });
      app.emitPropertyValue('nmea0183sentenceParser', { sentence: 'DSE', parser: handleDseSentence });
      dscParsersRegistered = true;
    }
    // Remove-before-add keeps the N2K listener idempotent even if the server
    // ever calls start() again without an intervening stop().
    app.removeListener('N2KAnalyzerOut', handleDscPgn);
    app.on('N2KAnalyzerOut', handleDscPgn);

    updatePluginStatus();
    getConfiguration();
    sendMetadata();

    // Refresh data after a warm-up period
    setTimeout( function() {
      sendMetadata();
      sendAisTargets();
      updatePluginStatus();
    }, 60 * 1000);

    sendMetadataProcess = setInterval( function() {
      sendMetadata();
    }, SEND_METADATA_INTERVAL * 60 * 60 * 1000);

    aisSubmissionProcess = setInterval( function() {
      sendAisTargets();
    }, AIS_SUBMISSION_INTERVAL * 60 * 1000);

    submitDataProcess = setInterval( function () {
      let now = Date.now();
      if ((!submitLastCalled) || (now - submitLastCalled > 2 * SUBMIT_INTERVAL * 60 * 1000)) {
        app.debug(`No data has been sent to the server since ${submitLastCalled}, submitting`);
        submitDataToServer();
      }
    }, SUBMIT_INTERVAL * 60 * 1000);
  }

  function updatePluginStatus() {
    try {
      let message;
      queueLength = bufferStore ? bufferStore.count() : 0;
      if (queueLength == 1) {
        message = `${queueLength} entry in the local cache,`;
      } else {
        message = `${queueLength} entries in the local cache,`;
      }
      if (lastSuccessfulUpdate) {
        let since = timeSince(lastSuccessfulUpdate);
        message += ` last connection to the server was ${since}.`;
      } else {
        message += ` no successful connection to the server since restart.`;
      }
      app.setPluginStatus(message);
    } catch (err) {
      app.debug('Error querying the local cache:', err);
    }
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
    try {
      configStore.save(monitoringConfiguration);
      app.debug('Configuration stored locally');
    } catch (err) {
      app.debug(`Failed to store configuration locally ${err}`);
    }
  }

  function loadConfiguration() {
    try {
      const cfg = configStore.load();
      if (cfg) {
        app.debug('Configuration loaded from local storage');
        monitoringConfiguration = cfg;
      } else {
        app.debug('No locally stored configuration found');
      }
    } catch (err) {
      app.debug(`Failed to load configuration: ${err}`);
    }
  }

  function getConfiguration() {
    if (retrieveMonitoringConfigInProgress) {
      app.debug('Monitoring configuration retrieval already in progress');
      return;
    }
    retrieveMonitoringConfigInProgress = true;
    app.debug('Retrieving monitoring configuration');
    let options = {
      uri: API_BASE + '/monitoring/' + uuid + '/configuration',
      method: 'GET',
      headers: {
        'User-Agent': userAgent,
      },
      timeout: 15000
    };
    request.get(options, function (error, response, body) {
      if (!error && response.statusCode == 200) {
        monitoringConfiguration = JSON.parse(body);
        app.debug(`Monitoring configuration: ${JSON.stringify(monitoringConfiguration)}`);
        saveConfiguration();
	updateDatabase();
      } else {
        app.debug('Failed to get monitoring configuration, trying to load from local storage');
        loadConfiguration();
      }
      retrieveMonitoringConfigInProgress = false;
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
      },
      timeout: 45000
    };

    app.debug (`Sending metadata`);
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
    if ((!position) || (!position.changedOn)) {
      return
    }

    let timeSinceLastUpdate;
    let dateNow = Date.now();
    if (updateLastCalled) {
      timeSinceLastUpdate = dateNow  - updateLastCalled;
    }
    if ((timeSinceLastUpdate) && (timeSinceLastUpdate < SUBMIT_INTERVAL * 60 * 1000)) {
      // Multiple GPS sources, updates coming in too frequently
      return;
    }
    updateLastCalled = dateNow;

    let monitoringDataInJson = null;
    if (monitoringConfiguration) {
      let monitoringData = getMonitoringData(monitoringConfiguration);
      monitoringDataInJson = JSON.stringify(monitoringData);
    } else {
      getConfiguration();
      monitoringDataInJson = null;
    }
    const row = {
      ts: position.changedOn,
      latitude: position.latitude,
      longitude: position.longitude,
      speedOverGround: maxSpeedOverGround,
      courseOverGroundTrue: courseOverGroundTrue,
      windSpeedApparent: windSpeedApparent,
      angleSpeedApparent: angleSpeedApparent,
      portEngineHours: portEngineHours,
      starboardEngineHours: starboardEngineHours,
      additionalData: monitoringDataInJson
    };

    if (!dBInsertInProgress) {
      dBInsertInProgress = true;
      try {
        bufferStore.insert(row);
        app.debug(`Inserted logging and monitoring data into the local cache`);
        queueLength++;
        windSpeedApparent = 0;
        maxSpeedOverGround = 0;
	portEngineHours = null;
	starboardEngineHours = null;
        submitDataToServer();
      } catch (err) {
        app.debug(`Failed to insert data: ${err}`);
      } finally {
        dBInsertInProgress = false;
      }
    }
  }

  function submitDataToServer() {
    submitLastCalled = Date.now();

    let data;
    try {
      data = bufferStore.peek(60);
    } catch (err) {
      app.debug('Error querying the local cache:', err);
      return;
    }

    if (!data) {
      app.debug('No data in the local cache');
      return;
    }
    if (data.length == 0) {
      app.debug('Local cache is empty, sending an empty ping');
    } else {
      app.debug(`Submitting ${data.length} out of ${queueLength} entries from the local cache`);
    }

    let httpOptions = {
      uri: API_BASE + '/' + uuid + '/push',
      method: 'POST',
      json: JSON.stringify(data),
      headers: {
        'User-Agent': userAgent,
      },
      timeout: 45000
    };

    request(httpOptions, function (error, response, body) {
      if (!error && response.statusCode == 200) {
        let responseBody = body;
        if (typeof responseBody === 'string') {
          try {
            responseBody = JSON.parse(responseBody);
          } catch (err) {
            if (data.length === 0) {
              app.debug('Server acknowledged empty ping');
              lastSuccessfulUpdate = Date.now();
              updatePluginStatus();
              return;
            }
            app.debug(`Server returned invalid JSON response; keeping local cache: ${err}`);
            updatePluginStatus();
            return;
          }
        }
        if (!responseBody || typeof responseBody !== 'object') {
          if (data.length === 0) {
            app.debug('Server acknowledged empty ping');
            lastSuccessfulUpdate = Date.now();
            updatePluginStatus();
            return;
          }
          app.debug('Server returned an empty or invalid response; keeping local cache');
          updatePluginStatus();
          return;
        }

        app.debug(`Successfully submitted ${data.length} data record(s)`);
        if (responseBody.refreshMetadata) {
          app.debug('Server requested metadata refresh');
          sendMetadata();
        }
        if (monitoringConfiguration && (responseBody.configurationVersion > monitoringConfiguration.version)) {
          app.debug(`New monitoring configuration available (v${responseBody.configurationVersion})`);
          getConfiguration();
        }
        if (data.length === 0 && responseBody.processedUntil === undefined) {
          lastSuccessfulUpdate = Date.now();
          updatePluginStatus();
          return;
        }
        try {
          const lastTs = responseBody.processedUntil;
          bufferStore.deleteUpTo(lastTs);
          lastSuccessfulUpdate = Date.now();

          const remaining = bufferStore.count();
          if (remaining > 1) {
            app.debug(`Cache not fully flushed, processed until ${lastTs}, ${remaining} record(s) left.`);
          }
        } catch (err) {
          app.debug(`Error deleting from buffer: ${err}`);
        }
      } else if (!error && response.statusCode == 204) {
        app.debug('Server responded with HTTP-204');
      } else {
        app.debug(`${response?.statusCode ? `HTTP-${response.statusCode}` : error || 'Unknown error'}, retry in ${SUBMIT_INTERVAL} min`);
      }
      updatePluginStatus();
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
      app.debug('Monitoring configuration not available yet, skipping AIS submissions');
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
      },
      timeout: 60000
    };

    app.debug(`Sending AIS data for ${Object.keys(data.aisTargets).length} vessels`);
    request(httpOptions, function (error, response, responseData) {
      if (!error && response.statusCode == 200) {
        app.debug(`AIS data successfully submitted`);
      } else {
        app.debug('Submission of AIS data failed');
      }
    });
  }

  function ownPositionNow() {
    let pos = app.getSelfPath('navigation.position');
    if (pos && pos.value && typeof pos.value.latitude === 'number') {
      return { latitude: pos.value.latitude, longitude: pos.value.longitude };
    }
    return null;
  }

  function sendDscEvent(event, attempt, targetUuid) {
    attempt = attempt || 1;
    // Bind the uuid from when the call arrived, so a retry that fires after a
    // restart with a different Collector ID still posts to the original boat.
    targetUuid = targetUuid || uuid;
    let httpOptions = {
      uri: API_BASE + '/dsc/' + targetUuid + '/push',
      method: 'POST',
      json: JSON.stringify(event),
      headers: {
        'User-Agent': userAgent,
      },
      timeout: 30000
    };
    request(httpOptions, function (error, response, body) {
      let status = response ? response.statusCode : null;
      if (!error && status >= 200 && status < 300) {
        // 2xx = accepted, including a server-deduped repeat.
        app.debug(`DSC ${event.category} call from MMSI ${event.mmsi || 'unknown'} submitted (HTTP-${status})`);
      } else if (!error && status >= 300 && status < 500) {
        // Permanent: a 4xx client error (400 bad body, 404 unknown collector id)
        // or a 3xx redirect a POST will not follow. Retrying will not help.
        app.debug(`DSC submission not accepted (HTTP-${status}), dropping`);
      } else if (attempt < DSC_MAX_ATTEMPTS) {
        // Transient failure (5xx, network/timeout, or an undiagnosable response):
        // retry, then drop. Skip scheduling if the plugin has since stopped so a
        // late callback cannot leak a timer past stop() or re-send under a new uuid.
        if (!dscStarted) return;
        app.debug(`DSC submission failed (${status ? `HTTP-${status}` : error}, attempt ${attempt}/${DSC_MAX_ATTEMPTS}), retrying in ${DSC_RETRY_INTERVAL}s`);
        let timer = setTimeout(function () {
          dscRetryTimers = dscRetryTimers.filter(function (t) { return t !== timer; });
          if (dscStarted) sendDscEvent(event, attempt + 1, targetUuid);
        }, DSC_RETRY_INTERVAL * 1000);
        dscRetryTimers.push(timer);
      } else {
        app.debug(`DSC submission failed after ${DSC_MAX_ATTEMPTS} attempts, dropping`);
      }
    });
  }

  function forwardDscCall(parsed, meta) {
    let event = Object.assign({
      receivedAt: meta.receivedAt || new Date().toISOString(),
      source: meta.source,
      raw: meta.raw
    }, parsed);
    let ownPosition = ownPositionNow();
    if (ownPosition) {
      event.ownPosition = ownPosition;
    }
    // selfMmsi comes straight from the data model (may be a number or an
    // unpadded string); event.mmsi is always a 9-digit string, so compare in
    // a normalized form.
    if (event.mmsi && selfMmsi != null &&
        event.mmsi === String(selfMmsi).padStart(9, '0')) {
      event.self = true;
    }
    sendDscEvent(event);
    return event;
  }

  // Keep a recently forwarded DSC call so a following $--DSE sentence can refine
  // its (whole-minute) position. DSC traffic is rare, so a short in-memory list
  // pruned by the pairing window is enough.
  function recordDscForDse(event) {
    recentDscCalls.push({ event: event, ts: Date.now() });
    let cutoff = Date.now() - DSE_PAIR_WINDOW * 60 * 1000;
    recentDscCalls = recentDscCalls.filter(function (c) { return c.ts >= cutoff; });
  }

  function findRecentDscForDse(mmsi) {
    let cutoff = Date.now() - DSE_PAIR_WINDOW * 60 * 1000;
    for (let i = recentDscCalls.length - 1; i >= 0; i--) {
      if (recentDscCalls[i].ts < cutoff) break;
      if (recentDscCalls[i].event.mmsi === mmsi) {
        return recentDscCalls[i].event;
      }
    }
    return null;
  }

  function handleDscSentence(input) {
    if (!dscStarted) return null;
    try {
      let parsed = parseDsc(input.parts);
      if (!parsed) return null;
      if (parsed.position) {
        parsed.positionResolution = 'minute';
      }
      let event = forwardDscCall(parsed, {
        source: 'nmea0183',
        raw: input.sentence,
        receivedAt: input.tags && input.tags.timestamp
      });
      if (event.mmsi && event.position && event.positionResolution === 'minute') {
        recordDscForDse(event);
      }
    } catch (err) {
      app.debug(`DSC parse failed: ${err.message}`);
    }
    // Forward-only: consume the sentence, emit no Signal K delta.
    return null;
  }

  function handleDseSentence(input) {
    if (!dscStarted) return null;
    try {
      let ext = parseDse(input.parts);
      if (!ext) return null;
      let target = findRecentDscForDse(ext.mmsi);
      if (!target) return null;
      let refined = refinePosition(target.position, ext);
      let event = Object.assign({}, target, {
        position: refined,
        positionResolution: 'enhanced',
        positionRefined: true,
        raw: input.sentence,
        receivedAt: new Date().toISOString()
      });
      // Re-sample own position so the observer annotation matches when the
      // refinement is forwarded, not when the original DSC call arrived.
      let ownPosition = ownPositionNow();
      if (ownPosition) {
        event.ownPosition = ownPosition;
      } else {
        delete event.ownPosition;
      }
      sendDscEvent(event);
    } catch (err) {
      app.debug(`DSE parse failed: ${err.message}`);
    }
    return null;
  }

  function handleDscPgn(pgnData) {
    if (!dscStarted || !pgnData || pgnData.pgn !== DSC_PGN) return;
    try {
      // Dump the raw PGN field shape so the actual canboatjs field naming on
      // this server can be analyzed (camelCase vs. canboat's spaced form).
      app.debug(`DSC PGN 129808 received; raw fields: ${JSON.stringify(pgnData.fields)}`);
      let parsed = normalizePgn129808(pgnData);
      let fieldCount = pgnData.fields ? Object.keys(pgnData.fields).length : 0;
      if (parsed.category === 'unknown' && !parsed.mmsi && !parsed.position) {
        // Nothing usable decoded (e.g. a field-key mismatch): log the shape for
        // analysis but do not forward noise to the backend.
        if (fieldCount) {
          app.debug(`DSC PGN 129808 did not decode despite ${fieldCount} field(s); ` +
            `unrecognized field keys: ${Object.keys(pgnData.fields).join(', ')}`);
        }
        return;
      }
      forwardDscCall(parsed, {
        source: 'n2k',
        raw: pgnData.fields
      });
    } catch (err) {
      app.debug(`PGN 129808 handling failed: ${err.message}`);
    }
  }

  function getMonitoringData(configuration) {
      let data = {
        sog: metersPerSecondToKnots(getKeyValue('navigation.speedOverGround', 60)),
        cog: radiantToDegrees(getKeyValue('navigation.courseOverGroundTrue', 60)),
        heading: radiantToDegrees(getKeyValue('navigation.headingTrue', 60)),
        // Most NMEA 2000 networks publish only a magnetic heading; send it
        // under its own name.
        headingMagnetic: radiantToDegrees(getKeyValue('navigation.headingMagnetic', 60)),
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
        let value = getKeyValue(key, 90);
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
      return Math.floor(interval) + " years ago";
    }
    interval = seconds / 2592000;
    if (interval > 1) {
      return Math.floor(interval) + " months ago";
    }
    interval = seconds / 86400;
    if (interval > 1) {
      return Math.floor(interval) + " days ago";
    }
    interval = seconds / 3600;
    if (interval > 1) {
      return Math.floor(interval) + " hours ago";
    }
    interval = seconds / 60;
    if (interval > 1) {
      return Math.floor(interval) + " minutes ago";
    }
    if (Math.floor(seconds) == 0) {
      return "few moments ago"
    }
    return Math.floor(seconds) + " seconds ago";
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

    switch (path) {
      case 'navigation.position':
        let source = data.updates[0]['$source'];
        if ((gpsSource) && (source != gpsSource)) {
          app.debug(`Skipping position from GPS resource ${source}`);
	  break;
	}
        position = value;
        position.changedOn = Date.now();
        updateDatabase();
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
      case 'propulsion.port.runTime':
        portEngineHours = Math.round(10 * value / 3600) / 10;
        break;
      case 'propulsion.starboard.runTime':
        starboardEngineHours = Math.round(10 * value / 3600) / 10;
        break;
      default:
        app.error('Unknown path: ' + path);
    }
  }

  return plugin;
}
