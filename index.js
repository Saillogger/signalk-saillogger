/*
 * Copyright 2019 Ilker Temir <ilker@ilkertemir.com>
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

const POLL_INTERVAL = 10      // Poll every N seconds
const SUBMIT_INTERVAL = 15    // Submit to API every N minutes
const MIN_DISTANCE = 0.75     // Update database if moved X miles
const MIN_TURN = 10           // Update database if turned X degrees
const DB_UPDATE_MINUTES = 10  // Update database every N minutes (worst case)
const SPEED_THRESHOLD = 0.25  // When to consider a vessel stopped (knots)
const API_BASE = 'https://saillogger.com/api/v1/collector'
//const API_BASE = 'http://davinci.ilkertemir.com:8888/api/v1/collector'

const fs = require('fs')
const filePath = require('path')
const request = require('request')
const sqlite3 = require('sqlite3')

module.exports = function(app) {
  var plugin = {};
  var unsubscribes = [];
  var submitProcess;
  var db;

  var updateLastCalled = Date.now();
  var position;
  var speedOverGround;
  var courseOverGroundTrue;
  var windSpeedApparent;
  var angleSpeedApparent;

  plugin.id = "signalk-saillogger";
  plugin.name = "SignalK SailLogger";
  plugin.description = "SailLogger plugin for Signal K";

  plugin.start = function(options) {
    if (!options.uuid) {
      app.error('Collector ID is required');
      return
    } 

    let data = {
      name: app.getSelfPath('name'),
      mmsi: app.getSelfPath('mmsi'),
      length: app.getSelfPath('design.length.value.overall'),
      beam:  app.getSelfPath('design.beam.value'),
      height:  app.getSelfPath('design.airHeight.value'),
      ship_type: app.getSelfPath('design.aisShipType.value.id')
    }

    let postData = {
      uri: API_BASE + '/' + options.uuid + '/update',
      method: 'POST',
      json: JSON.stringify(data)
    };

    request(postData, function (error, response, body) {
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
          }
        }); 
      });
    }, SUBMIT_INTERVAL * 60 * 1000);
  }

  plugin.stop =  function() {
    clearInterval(submitProcess);
    db.close();
  };

  plugin.schema = {
    type: 'object',
    required: ['uuid'],
    properties: {
      uuid: {
        type: "string",
        title: "Collector ID (obtain from SailLogger app)"
      },
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

    db.run('INSERT INTO buffer VALUES(?, ?, ?, ?, ?, ?, ?)', values);
    position.changedOn = null;
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

  function processDelta(data) {
    let dict = data.updates[0].values[0];
    let path = dict.path;
    let value = dict.value;
    let timePassed = Date.now() - updateLastCalled;

    switch (path) {
      case 'navigation.position':
        if (position) {
          position.changedOn = Date.now();
     
          if (timePassed >= 60 * 1000) {
            // Don't push updates more than once every 1 minute
            let distance = calculateDistance(position.latitude,
                                             position.longitude,
                                             value.latitude,
                                             value.longitude);
            if (distance >= MIN_DISTANCE) {
              // Update the database if we moved more than a minimum distance
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
        speedOverGround = metersPerSecondToKnots(value);
        break;
      case 'navigation.courseOverGroundTrue':
        courseOverGroundTrue = radiantToDegrees(value);
        break;
      case 'environment.wind.speedApparent':
        windSpeedApparent = metersPerSecondToKnots(value);
        break;
      case 'environment.wind.angleApparent':
        angleSpeedApparent = radiantToDegrees(value);
        break;
      default:
        app.error('Unknown path: ' + path);
    }
    if (timePassed > DB_UPDATE_MINUTES * 60 * 1000) {
      // Worst case update the DB every N minutes
      updateDatabase();
    }
  }

  return plugin;
}
