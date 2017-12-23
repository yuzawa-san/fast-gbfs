var $ = require('npm-zepto');
var L = require('leaflet');
require('compass-js');
var Compass = window.Compass;
(function() {
    // fetch the station info this often
    var fetchMs = 30000;
    // redraw the list this often
    var renderMs = 10000;

    var languages = navigator.languages || [];
    var imperialUnits = languages.indexOf("en-US") >= 0;

    var arrowUrl = URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><path id="arrow" fill="#007BFF" d="M 50,0 L 100,100 L 50,70 L 0,100" /></svg>'], {
        type: 'image/svg+xml'
    }));
    var dotUrl = URL.createObjectURL(new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="175" height="175"><circle cx="85" cy="85" r="63" fill="#00ccff" stroke="#007BFF" stroke-width="44"/></svg>'], {
        type: 'image/svg+xml'
    }));
    $("#center-icon").attr('src', dotUrl);

    var timers = {};

    function timerStart(key) {
        timers[key] = Date.now();
    }

    function timerEnd(key, xhr) {
        var startMs = timers[key];
        var content = Math.round(Date.now() - startMs) + "ms";
        if (xhr) {
            content += " (" + (xhr.responseText.length / 1024).toFixed(1) + "kb)";
        }
        $("#timing-" + key).text(content);
    }

    var systemId = null;
    var stations = null;
    var currentPosition = null;
    var $stationList = $("#station-list");

    var geo = {
        nearby: function(lat, lon, items, count) {
            var nearestStations = [];
            for (var i in items) {
                var item = items[i];
                var delta = geo.delta(lat, lon, item.lat, item.lon);
                item.distance = delta.distance;
                item.bearing = delta.bearing;
                nearestStations.push(item);
            }
            nearestStations.sort(function(a, b) {
                return a.distance - b.distance;
            });
            if (count) {
                nearestStations = nearestStations.slice(0, count);
            }
            return nearestStations;
        },
        closest: function(lat, lon, items) {
            return this.nearby(lat, lon, items)[0];
        },
        delta: function(lat1, lon1, lat2, lon2) {
            var R = 6371000.2161; // Radius of the earth in meters
            var dLat = this._toRad(lat2 - lat1); // this._toRad below
            var dLon = this._toRad(lon2 - lon1);
            var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(this._toRad(lat1)) * Math.cos(this._toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
            var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            var d = R * c; // Distance in meters
            var y = Math.sin(dLon) * Math.cos(this._toRad(lat2));
            var x = Math.cos(this._toRad(lat1)) * Math.sin(this._toRad(lat2)) - Math.sin(this._toRad(lat1)) * Math.cos(this._toRad(lat2)) * Math.cos(dLon);
            var brng = this._toDeg(Math.atan2(y, x));
            var b = ((brng + 360) % 360);
            return {
                distance: d,
                bearing: b
            };

        },
        _toRad: function(deg) {
            return deg * Math.PI / 180;
        },
        _toDeg: function(rad) {
            return rad * 180 / Math.PI;
        },
        cardinalDirection: function(angle) {
            //easy to customize by changing the number of directions you have 
            var directions = 8;

            var degree = 360 / directions;
            angle = angle + degree / 2;

            if (angle >= 0 * degree && angle < 1 * degree) return "N";
            if (angle >= 1 * degree && angle < 2 * degree) return "NE";
            if (angle >= 2 * degree && angle < 3 * degree) return "E";
            if (angle >= 3 * degree && angle < 4 * degree) return "SE";
            if (angle >= 4 * degree && angle < 5 * degree) return "S";
            if (angle >= 5 * degree && angle < 6 * degree) return "SW";
            if (angle >= 6 * degree && angle < 7 * degree) return "W";
            if (angle >= 7 * degree && angle < 8 * degree) return "NW";
            //Should never happen: 
            return "N";
        }
    };

    var map = L.map('map').setZoom(15);
    var desktop = window.innerWidth > 700;

    var myIcon = L.divIcon({
        className: 'bearing-container',
        iconSize: [20, 20],
        iconAnchor: [10, 10],
        'html': '<img src="' + arrowUrl + '" class="your-bearing" width=20>'
    });

    L.control.scale({
        "position": "topright"
    }).addTo(map);

    var youMarker = L.marker();
    var youAccuracy = L.circle();

    var markerMap = {};
    var bikeMarkers = {};

    function pivot(data) {
        if (!data) {
            return [];
        }
        var out = [];
        for (var i = 1; i < data.length; i++) {
            var obj = {};
            var row = data[i];
            for (var j = 0; j < data[i].length; j++) {
                obj[data[0][j]] = data[i][j];
            }
            out.push(obj);
        }
        return out;
    }

    var filter = 'all';
    $(".filter").click(function() {
        $(".filter").removeClass("active");
        filter = $(this).attr('id').replace('filter-', '');
        $(this).addClass("active");
        draw();
        localStorage.setItem('filter', filter);
    });

    var baseSelection = desktop ? "retina" : "default";
    try {
        filter = localStorage.getItem('filter');
        if (filter) {
            $('#filter-' + filter).trigger('click');
        }
        var selectedBase = localStorage.getItem("base");
        if (selectedBase) {
            baseSelection = selectedBase;
        }
    } catch (e) {}
    var subdomain = 'a';
    if (desktop) {
        // this will open multiple connections which is ok on desktop
        subdomain = '{s}'
    }
    var defaultBase = L.tileLayer('https://' + subdomain + '.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}.png', {
        attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OSM</a>, &copy; <a href="https://carto.com/attribution">CARTO</a>'
    });
    var retinaBase = L.tileLayer('https://' + subdomain + '.basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="http://www.openstreetmap.org/copyright">OSM</a>, &copy; <a href="https://carto.com/attribution">CARTO</a>'
    });
    L.GridLayer.GridLines = L.GridLayer.extend({
        createTile: function(coords) {
            var tile = document.createElement('canvas');

            var tileSize = this.getTileSize();
            tile.setAttribute('width', tileSize.x);
            tile.setAttribute('height', tileSize.y);
            tile.setAttribute("data-z", coords.z);

            var y = map.getSize().y / 2;
            var tileMeters = 40075016.686 * Math.abs(Math.cos(map.getCenter().lat * Math.PI / 180)) / Math.pow(2, coords.z + 8);
            var spacing = imperialUnits ? 91.44 : 100;
            var jump = Math.round(spacing / tileMeters);

            var ctx = tile.getContext('2d');
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, tileSize.x, tileSize.y);
            ctx.lineWidth = 1;
            ctx.strokeStyle = "#eee";
            ctx.beginPath();
            for (var x = 0; x < tileSize.x; x++) {
                if ((coords.x * tileSize.x + x) % jump == 0) {
                    ctx.moveTo(x + 0.5, 0);
                    ctx.lineTo(x + 0.5, tileSize.y);
                }
            }
            for (var y = 0; y < tileSize.y; y++) {
                if ((coords.y * tileSize.y + y) % jump == 0) {
                    ctx.moveTo(0, y + 0.5);
                    ctx.lineTo(tileSize.x, y + 0.5);
                }
            }
            ctx.stroke();
            return tile;
        }
    });

    L.gridLayer.gridLines = function(opts) {
        return new L.GridLayer.GridLines(opts);
    };
    var gridLayer = L.gridLayer.gridLines({
        minZoom: 12
    });
    defaultBase.on('add', function() {
        localStorage.setItem("base", "default");
    });
    retinaBase.on('add', function() {
        localStorage.setItem("base", "retina");
    });
    gridLayer.on('add', function() {
        localStorage.setItem("base", "grid");
    });

    function populateMap() {
        if (baseSelection == "retina") {
            retinaBase.addTo(map);
        } else if (baseSelection == "grid") {
            gridLayer.addTo(map);
        } else {
            defaultBase.addTo(map);
        }
    }

    var gridLabel = (imperialUnits ? "300ft" : "100m") + " grid (No-Data)";
    var baseLayers = {
        "Default": defaultBase,
        "Retina (High-Data)": retinaBase
    };
    baseLayers[gridLabel] = gridLayer;

    var systemsLayer = L.layerGroup();
    var stationLayer = L.layerGroup().addTo(map);
    var bikeLayer = L.layerGroup().addTo(map);

    var overlays = {
        "Stations": stationLayer,
        "Floating Bikes": bikeLayer
    };
    var controls = L.control.layers(baseLayers, overlays, {
        "position": "bottomleft"
    }).addTo(map);

    var $prefs = $("#prefs");
    var $systemList = $("#system-list");
    var $toggle = $("#toggle").click(function() {
        if ($(this).hasClass("active")) {
            controls.addTo(map);
            stationLayer.addTo(map);
            bikeLayer.addTo(map);
            systemsLayer.remove();
            map.setView([currentPosition.coords.latitude, currentPosition.coords.longitude], desktop ? 16 : 15);
            $(this).removeClass("active");
            $prefs.hide();
            $systemList.hide();
            $stationList.show();
        } else {
            controls.remove();
            stationLayer.remove();
            bikeLayer.remove();
            systemsLayer.addTo(map);
            map.setZoom(6);
            $(this).addClass("active");
            $prefs.show();
            $systemList.show();
            $stationList.hide();
        }
    });

    if (navigator.geolocation) {
        var geo_options = {
            enableHighAccuracy: true,
            maximumAge: 30000,
            timeout: 27000
        };
        timerStart("geolocation");
        navigator.geolocation.watchPosition(function(position) {
            var initial = !currentPosition;
            currentPosition = position;
            var newLatLng = new L.LatLng(position.coords.latitude, position.coords.longitude);
            youMarker.setLatLng(newLatLng);
            youAccuracy.setLatLng(newLatLng);
            youAccuracy.setRadius(position.coords.accuracy);
            if (initial) {
                timerEnd("geolocation");
                map.setView(newLatLng, desktop ? 16 : 15);
                determineSystem();
            }
        }, function(e) {
            alert("Sorry, no position available: " + e.message);
        }, geo_options);
    }

    function determineSystem() {
        var lat = currentPosition.coords.latitude;
        var lon = currentPosition.coords.longitude;
        timerStart("system-list");
        $.get("/systems", function(response, status, xhr) {
            timerEnd("system-list", xhr);
            var systems = pivot(response);
            var nearbySystems = geo.nearby(lat, lon, systems);
            var $system = $("#system");
            var system = nearbySystems[0];
            var override = window.location.hash;
            var nearbySystemCount = 0;
            for (var i in nearbySystems) {
                var nearbySystem = nearbySystems[i];
                if (nearbySystem.distance < 50000) {
                    nearbySystemCount++;
                    $system.append('<option value="' + nearbySystem.id + '">' + nearbySystem.name + '</option>');
                    if (localStorage.getItem('system') === nearbySystem.id) {
                        system = nearbySystem;
                    }
                }
                if (override === "#" + nearbySystem.id) {
                    // manual override 
                    system = nearbySystem;
                    map.setView([nearbySystem.lat, nearbySystem.lon], map.getZoom());
                }
                var systemMarker = L.circle([nearbySystem.lat, nearbySystem.lon], {
                    radius: 15000,
                    weight: 1,
                    dashArray: "2, 2",
                    lineCap: "butt",
                    fillColor: "rgb(253,77,2)",
                    fillOpacity: 0.3,
                    color: "rgb(253,77,2)",
                    opacity: 1.0
                });
                systemMarker.bindTooltip(nearbySystem.name);
                systemMarker.addTo(systemsLayer);
            }
            if (nearbySystemCount <= 1) {
                $system.hide();
            }
            $system.val(system.id);
            $system.change(function() {
                localStorage.setItem('system', $(this).val());
                window.location.reload();
            });
            L.setOptions(youAccuracy, {
                opacity: 0.3,
                weight: 1,
                interactive: false,
                fillColor: "#00ccff",
                color: "#007BFF"
            });
            youAccuracy.addTo(map);
            L.setOptions(youMarker, {
                icon: myIcon,
                interactive: false,
                attribution: system.name
            });
            youMarker.addTo(map);
            if (!override && system.distance > 50000) {
                $stationList.html('<div class="message">No bikeshare system with GBFS feed nearby!</div>');
            } else {
                systemId = system.id
                timerStart("system-info");
                $.get("/systems/" + systemId + "/info", function(response, status, xhr) {
                    timerEnd("system-info", xhr);
                    response.stations = pivot(response.stations);
                    response.stationMap = {}
                    for (var i in response.stations) {
                        var station = response.stations[i]
                        response.stationMap[station.id] = station;
                    }
                    loadSystem(response);
                });
            }

            Compass.noSupport(function() {
                $('.your-bearing').attr("src", dotUrl);
            }).watch(function(heading) {
                $('.your-bearing').css('transform', 'rotate(' + (heading) + 'deg)');
            });

            $("#center").click(function() {
                map.setView([currentPosition.coords.latitude, currentPosition.coords.longitude], map.getZoom());
            });
        });
    }

    var lastFetch = 0;

    $("#map").on("click", ".favorite-toggle", function() {
        var stationId = $(this).attr("data-id");
        if (toggleFavorite(stationId)) {
            $(this).html("&#x2606;");
        } else {
            $(this).html("&#x2605;");
        }
    });

    function getFavorites() {
        var faves = localStorage.getItem("fave_" + systemId);
        if (faves) {
            faves = JSON.parse(faves);
        } else {
            faves = {};
        }
        return faves;
    }

    function toggleFavorite(id) {
        var faves = getFavorites();
        if (faves[id]) {
            delete faves[id];
        } else {
            faves[id] = 1;
        }
        localStorage.setItem("fave_" + systemId, JSON.stringify(faves));
        draw();
        return faves[id];
    }

    function loadSystem(systemInfo) {
        function fetch() {
            timerStart("system-status");
            $.get("/systems/" + systemId + "/status", function(response, status, xhr) {
                timerEnd("system-status", xhr);
                var statuses = pivot(response.statuses);
                var globalAlerts = [];
                var nonGlobalAlerts = [];
                for (var i in response.alerts) {
                    var alert = response.alerts[i];
                    if (alert['station_ids'] || alert['region_ids']) {
                        nonGlobalAlerts.push(alert);
                    } else {
                        globalAlerts.push(alert);
                    }
                }
                var stationList = [];
                var favorites = getFavorites();
                for (var i in statuses) {
                    var station = statuses[i];
                    var stationInfo = systemInfo.stationMap[station.id];
                    if (!stationInfo) {
                        continue;
                    }
                    for (var j in stationInfo) {
                        station[j] = stationInfo[j];
                    }
                    stationList.push(station);
                    station.alerts = [];
                    for (var j in globalAlerts) {
                        station.alerts.push(alert);
                    }
                    station.type = "station";
                    var stationId = station.id;
                    for (var j in nonGlobalAlerts) {
                        var alert = nonGlobalAlerts[j];
                        var stationIds = alert['station_ids'] || [];
                        var regionIds = alert['region_ids'] || [];
                        if (stationIds.indexOf(stationId) > -1 || regionIds.indexOf(station.region) > -1) {
                            station.alerts.push(alert);
                        }
                    }
                    var marker = markerMap[stationId];
                    if (!marker) {
                        marker = L.circleMarker([station.lat, station.lon], {
                            radius: desktop ? 12 : 10,
                            color: "rgb(253,77,2)",
                            weight: station.alerts.length > 0 ? 4 : 2,
                            fillOpacity: 1.0
                        });
                        markerMap[stationId] = marker;
                        marker.bindPopup(station.name);
                        marker.addTo(stationLayer);
                        var pointsIcon = L.divIcon({
                            className: 'points-icon'
                        });
                        var pointsMarker = L.marker([station.lat, station.lon], {
                            icon: pointsIcon,
                            interactive: false
                        }).addTo(stationLayer);
                        marker.pointsMarker = pointsMarker;

                    }
                    var pointsIcon = L.divIcon({
                        html: points(station.pts),
                        className: 'points-icon'
                    });
                    marker.pointsMarker.setIcon(pointsIcon);
                    var pct = NaN;
                    var bikes = station.bikes;
                    var docks = station.docks
                    var total = bikes + docks;
                    var fillColor = "#999";
                    if (total > 0) {
                        pct = bikes / total;
                        fillColor = "hsl(18, 100%, " + (100 - pct * 50).toFixed(1) + "%)";
                    }
                    station.pct = pct;
                    marker.setStyle({
                        fillColor: fillColor
                    });
                    var favorite = "&#x2605;";
                    if (favorites[station.id]) {
                        favorite = "&#x2606;";
                    }
                    marker.setPopupContent("<strong>" + station.name + "</strong><br>" + bikes + " bikes " + docks + " docks" + alertsRows(station.alerts) + " " + points(station.pts) + "<br><button class='favorite-toggle' data-id='" + station.id + "'>" + favorite + "</button>")
                }
                stations = stationList;

                var bikes = pivot(response.bikes);
                var newBikeMarkers = {};
                for (var i in bikes) {
                    var bike = bikes[i];
                    var marker = markerMap['bike' + bike.id];
                    if (!marker) {
                        marker = L.circleMarker([bike.lat, bike.lon], {
                            radius: desktop ? 5 : 3,
                            weight: 0,
                            fillColor: "rgb(253,77,2)",
                            fillOpacity: 1.0
                        });
                        markerMap['bike' + bike.id] = marker;
                        marker.bindPopup(bike.name);
                        marker.addTo(bikeLayer);
                    }
                    newBikeMarkers[bike.id] = marker;
                    delete bikeMarkers[bike.id];
                    bike.pct = 1.0;
                    bike.type = "bike";
                    stations.push(bike)
                }
                for (var i in bikeMarkers) {
                    bikeMarkers[i].removeFrom(map);
                    delete markerMap['bike' + i];
                }
                bikeMarkers = newBikeMarkers;
                draw();
            });
        }

        function checkFetch() {
            var now = Date.now();
            var delta = now - lastFetch;
            var span = fetchMs;
            var pct = Math.min(1.0, delta / span);
            progress(pct);
            if (delta > span) {
                fetch();
                lastFetch = now;
            }
        }
        checkFetch();
        setInterval(checkFetch, 1000);
    }

    var arc = document.getElementById("status-arc");

    function progress(percent) {
        var half = percent > .5 ? 1 : 0;
        var x = Math.cos(2 * Math.PI * percent);
        var y = Math.sin(2 * Math.PI * percent);
        arc.setAttribute("d", "M 1 0 A 1 1 0 " + half + " 1 " + x + " " + y);
    }

    function pad(v) {
        if (v < 10) {
            return "&nbsp;" + v;
        }
        return v
    }

    function timeDelta(seconds) {
        var lastMod = "?";
        if (seconds > 0) {
            lastMod = Math.round(((Date.now() / 1000) - seconds) / 60);
        }
        var out = lastMod + "m ago";
        if (lastMod > 1440) {
            out = "<span style='color:red'>" + out + "</span>";
        }
        return out;
    }

    function prettyDate(since) {
        function pad(number) {
            if (number < 10) {
                return '0' + number;
            }
            return number;
        }

        return pad(since.getMonth() + 1) + "/" + pad(since.getDate()) + ' ' + pad(since.getHours()) + ':' + pad(since.getMinutes())
    }

    function alertsRows(alertList) {
        var alerts = "";
        if (alertList) {
            for (var i in alertList) {
                var alert = alertList[i];
                var typeName;
                switch (alert.type) {
                case 'SYSTEM_CLOSURE':
                    typeName = "System Closure";
                    break;
                case 'STATION_CLOSURE':
                    typeName = "Station Closure";
                    break;
                case 'STATION_MOVE':
                    typeName = "Station Move";
                    break;
                default:
                    typeName = "Notice";
                    break;
                }
                if (alert.times) {
                    for (var i in alert.times) {
                        var end = alert.times[i].end * 1000;
                        if (end && end < Date.now()) {
                            continue;
                        }
                        typeName += " (" + prettyDate(new Date(alert.times[i].start * 1000)) + " -> ";
                        if (end) {
                            typeName += prettyDate(new Date(end));
                        } else {
                            typeName += "?";
                        }
                        typeName += ")";
                    }
                }
                alerts += "<div class='alert " + alert.type + "'>" + typeName + ": " + alert.summary + " <em>" + timeDelta(alert.last_updated) + "</em></div>";
            }
        }
        return alerts;
    }

    function points(pts) {
        if (!pts) {
            return "";
        }
        if (pts < 0) {
            return "<span class='points-pick'>" + (-pts) + "</span>";
        } else {
            return "<span class='points-drop'>" + pts + "</span>";
        }
    }

    function stationRow(station, favorites) {
        var distance;
        if (imperialUnits) {
            var miles = station.distance / 1609.34;
            if (miles < 0.189) {
                distance = Math.round(miles * 5280) + "ft";
            } else {
                distance = miles.toFixed(1) + "mi";
            }
        } else {
            var meters = station.distance;
            if (meters < 500) {
                distance = Math.round(meters) + "m";
            } else {
                distance = (meters / 1e3).toFixed(1) + "km";
            }
        }
        var bearing = geo.cardinalDirection(station.bearing);
        if (station.type == 'bike') {
            return "<div class='station bike' data-id='bike" + station.id + "'><div class='station-body'><div class='health station-cell'>&#x1F6B2;</div><div class='station-cell'>" + "<div class='detail'>" + distance + " " + bearing + " | " + station.name + "</div></div></div></div></div>";
        }
        var lastMod = timeDelta(station.mod);

        var alerts = alertsRows(station.alerts);
        var bikePoints = "";
        var dockPoints = "";
        var pts = station.pts;
        if (pts < 0) {
            bikePoints = ", <span class='points-pick'>" + (-pts) + "pts</span>";
        } else if (pts > 0) {
            dockPoints = ", <span class='points-drop'>" + pts + "pts</span>";
        }
        var favorite = "";
        if (favorites[station.id]) {
            favorite = "&#x2605; ";
        }

        return "<div class='station' data-id='" + station.id + "'><div class='station-body'>" + "<div class='health station-cell'><progress value=" + station.bikes + " max=" + (station.bikes + station.docks) + "></progress></div><div class='station-cell'><div class='name'>" + favorite + station.name + "</div>" + "<div class='detail'>" + pad(station.bikes) + " bikes" + bikePoints + " | " + pad(station.docks) + " docks" + dockPoints + " | " + distance + " " + bearing + " | " + lastMod + "</div>" + alerts + "</div></div></div>";
    }

    var lastRender = 0;

    function draw() {
        if (stations) {
            var lat = currentPosition.coords.latitude;
            var lon = currentPosition.coords.longitude;
            var favorites = getFavorites();
            var effectiveStations = stations.filter(function(station) {
                var status;
                if (filter == "fave") {
                    status = favorites[station.id];
                } else if (filter == 'bike') {
                    status = station.pct > 0.05 || station.type == 'bike';
                } else if (filter == 'dock') {
                    status = station.pct < 0.95 && station.type == 'station';
                } else {
                    status = !isNaN(station.pct);
                }
                var id = station.id;
                if (station.type == 'bike') {
                    id = "bike" + id;
                }
                var marker = markerMap[id];
                var opacity = status ? 1.0 : 0.2;
                marker.setStyle({
                    opacity: opacity,
                    fillOpacity: opacity
                });
                if (marker.pointsMarker) {
                    marker.pointsMarker.setOpacity(opacity);
                }
                return status;
            });
            var nearestStations = geo.nearby(lat, lon, effectiveStations, 25);
            $stationList.empty();
            if (nearestStations.length === 0 && filter == "fave") {
                $stationList.append("<p class='message'>No Favorites<br><em>Click a station on map or double click a station in list to mark it as favorite.</em></p>");
            }
            for (var i in nearestStations) {
                var station = nearestStations[i];
                var $row = $(stationRow(station, favorites));
                $row.click(function() {
                    var marker = markerMap[$(this).attr('data-id')];
                    map.setView(marker.getLatLng(), map.getZoom());
                    var originalRadius = marker.options.radius;
                    var pct = 0;
                    var timer = setInterval(function() {
                        marker.setStyle({
                            radius: originalRadius + originalRadius / 2 * (1 - pct)
                        });
                        pct += 0.1;
                        if (pct >= 1.0) {
                            clearInterval(timer);
                        }
                    }, 50);
                }).dblclick(function() {
                    var marker = markerMap[$(this).attr('data-id')];
                    marker.openPopup();
                });
                $stationList.append($row);
            }
            if (lastRender === 0) {
                populateMap();
            }
            lastRender = Date.now();
        }
    }
    setInterval(function() {
        var now = Date.now();
        if ((now - lastRender) > renderMs) {
            draw();
        }
    }, 1000);
})();
