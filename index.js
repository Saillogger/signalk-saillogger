/*
 * Copyright 2019-2021 Ilker Temir <ilker@ilkertemir.com>
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

const POLL_INTERVAL = 10          // Poll every N seconds
const SUBMIT_INTERVAL = 15        // Submit to API every N minutes
const MIN_DISTANCE = 0.50         // Update database if moved X miles
const DB_UPDATE_MINUTES = 5       // Update database every N minutes (worst case)
const SPEED_THRESHOLD = 1         // When to consider a vessel slowed down (knots)
const MINIMUM_TURN_DEGREES =  20  // When to consider a vessel made a quick turn (degrees)
const API_BASE = 'https://saillogger.com/api/v1/collector'

const fs = require('fs')
const filePath = require('path')
const request = require('request')
const sqlite3 = require('sqlite3')
const package = require('./package.json');

module.exports = function(app) {
  var plugin = {};
  var unsubscribes = [];
  var submitProcess;
  var statusProcess;
  var db;
  var gpsSource;

  var updateLastCalled = Date.now();
  var lastSuccessfulUpdate;
  var position;
  var speedOverGround;
  var courseOverGroundTrue;
  var windSpeedApparent = 0;
  var angleSpeedApparent;
  var previousSpeeds = [];
  var previousCOGs = [];

  plugin.id = "signalk-saillogger";
  plugin.name = "SignalK SailLogger";
  plugin.description = "SailLogger plugin for Signal K";

  plugin.start = function(options) {
    if (!options.uuid) {
      app.error('Collector ID is required');
      return
    } 
    gpsSource = options.source;

    app.setPluginStatus('Saillogger started. Please wait for a status update.');
    let data = {
      name: app.getSelfPath('name'),
      mmsi: app.getSelfPath('mmsi'),
      length: app.getSelfPath('design.length.value.overall'),
      beam:  app.getSelfPath('design.beam.value'),
      height:  app.getSelfPath('design.airHeight.value'),
      ship_type: app.getSelfPath('design.aisShipType.value.id'),
      version: package.version
    }

    let postData = {
      uri: API_BASE + '/' + options.uuid + '/update',
      method: 'POST',
      json: JSON.stringify(data)
    };

    request(postData, function (error, response, body) {
      if (!error && response.statusCode == 200) {
        lastSuccessfulUpdate = Date.now();
      }
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

    submitProcess = setInterval( function() {
      db.all('SELECT * FROM buffer ORDER BY ts', function(err, data) {
        if (data.length == 0) {
          return
        }

        let httpOptions = {
          uri: API_BASE + '/' + options.uuid + '/push',
          method: 'POST',
          json: JSON.stringify(data)
        };

        request(httpOptions, function (error, response, body) {
          if (!error && response.statusCode == 200) {
            let lastTs = body.processedUntil;
            db.run('DELETE FROM buffer where ts <= ' + lastTs);
            lastSuccessfulUpdate = Date.now();
          }
        }); 
      });
    }, SUBMIT_INTERVAL * 60 * 1000);

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

  plugin.stop =  function() {
    clearInterval(submitProcess);
    clearInterval(statusProcess);
    db.close();
  };

  plugin.schema = {
    type: 'object',
    required: ['uuid'],
    properties: {
      uuid: {
        type: "string",
        title: "Collector ID (obtain from saillogger.com)"
      },
      source: {
        type: "string",
        title: "GPS source (only if you have multiple GPS sources and you want to use an explicit source)"
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
                  speedOverGround, courseOverGroundTrue, windSpeedApparent,
                  angleSpeedApparent];

    db.run('INSERT INTO buffer VALUES(?, ?, ?, ?, ?, ?, ?)', values, function(err) {
      windSpeedApparent = 0;
    });
    position.changedOn = null;
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
    return rad * 57.2958;
  }

  function metersPerSecondToKnots(ms) {
    return ms * 1.94384;
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
    if (previousCOGs.length < 3) {
      return (false);
    }
    let delta = previousCOGs[2] - previousCOGs[0];
    if (delta > MINIMUM_TURN_DEGREES) {
      return (true);
    } else {
      return (false);
    }
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
          position.changedOn = Date.now();
     
          if (timePassed >= 60 * 1000) {
            // Don't push updates more than once every 1 minute
            let distance = calculateDistance(position.latitude,
                                             position.longitude,
                                             value.latitude,
                                             value.longitude);
	    if (
                 // Want submissions at every DB_UPDATE_MINUTES
                 (timePassed >= DB_UPDATE_MINUTES * 60 * 1000) ||

                 // Or we moved a meaningful distance
                 (distance >= MIN_DISTANCE) ||

                 // Or we made a meaningful change of course
                 (vesselMadeSignificantTurn()) ||

                 // Or the boat has slowed down or has speeded up
                 ((speedOverGround <= SPEED_THRESHOLD) &&
                  (previousSpeeds.every(el => el > SPEED_THRESHOLD))) ||
                 ((speedOverGround > SPEED_THRESHOLD) &&
                  (previousSpeeds.every(el => el <= SPEED_THRESHOLD))) ||

                 ((speedOverGround <= SPEED_THRESHOLD * 2) &&
                  (previousSpeeds.every(el => el > SPEED_THRESHOLD * 2))) ||
                 ((speedOverGround > SPEED_THRESHOLD * 2) &&
                  (previousSpeeds.every(el => el <= SPEED_THRESHOLD * 2))) ||

                 ((speedOverGround <= SPEED_THRESHOLD * 3) &&
                  (previousSpeeds.every(el => el > SPEED_THRESHOLD * 3))) ||
                 ((speedOverGround > SPEED_THRESHOLD * 3) &&
                  (previousSpeeds.every(el => el <= SPEED_THRESHOLD * 3)))
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
        previousSpeeds.unshift(speedOverGround);
        previousSpeeds = previousSpeeds.slice(0, 3);
        break;
      case 'navigation.courseOverGroundTrue':
        // Keep the previous 3 values
        courseOverGroundTrue = radiantToDegrees(value);
	previousCOGs.unshift(courseOverGroundTrue);
	previousCOGs = previousCOGs.slice(0, 3);
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
    /*
    if (timePassed > DB_UPDATE_MINUTES * 60 * 1000 + POLL_INTERVAL * 1000) {
      // Worst case update the DB every N minutes
      updateDatabase();
    }
    */
  }

  return plugin;
}
