import geo from './geo.js';
import TinyGridLayer from './grid.js';
var $ = require('npm-zepto');
var L = require('leaflet');
var emojiFlags = require('emoji-flags');
require('compass-js');
var Compass = window.Compass;
(function() {
    function reportError(message) {
        $("#footer").prepend($("<p>").addClass("error").text(message));
    }
    window.onerror = reportError;
    $(document).on('ajaxError', function(e, xhr, options) {
        reportError("Failed to load " + xhr.responseURL + "\n" + xhr.status + " " + xhr.statusText);
        console.error(xhr);
    });
    // fetch the station info this often
    var fetchMs = 30000;
    // redraw the list this often
    var renderMs = 10000;

    var isFront = true;
    window.onblur = function() {
        isFront = false;
    };
    window.onfocus = function() {
        isFront = true;
    };

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
            var ageMs = Date.now() - new Date(xhr.getResponseHeader("date")).getTime();
            var cached = "";
            if (ageMs > 5000) {
                cached = ", cached";
            }
            content += " (" + (xhr.responseText.length / 1024).toFixed(1) + "kb" + cached + ")";
        }
        $("#timing-" + key).text(content);
    }

    function readableName(name) {
        // break on common elements for readability
        return name.replace(/([:&@\/]|\sat\s|\s-\s)/g, "$1<br>");
    }

    var systemId = null;
    var stations = null;
    var currentPosition = null;
    var $stationList = $("#station-list");
    var $toggle = $("#toggle");

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
        document.getElementById("content-scroll-inner").scrollTop = 0;
    });
    var $commute = $("#toggle-commute");
    $commute.click(function() {
        if ($commute.hasClass("active")) {
            $commute.removeClass("active");
            localStorage.removeItem('commute');
        } else {
            $commute.addClass("active");
            localStorage.setItem('commute', 1);
            document.getElementById("content-scroll-inner").scrollTop = 0;
        }
        draw();
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
        if (localStorage.getItem("commute")) {
            $commute.addClass("active");
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

    var gridLayer = TinyGridLayer(map);
    var gridGroup = L.layerGroup();
    gridLayer.addTo(gridGroup);
    var tooltipGroup = L.layerGroup();
    defaultBase.on('add', function() {
        localStorage.setItem("base", "default");
    });
    retinaBase.on('add', function() {
        localStorage.setItem("base", "retina");
    });

    function conditionallyRenderTooltips() {
        var zoomedIn = map.getZoom() > 14;
        var bounds = map.getBounds();
        tooltipGroup.eachLayer(function(tooltip) {
            if (zoomedIn && bounds.contains(tooltip.getLatLng())) {
                tooltip.addTo(gridGroup);
            } else {
                tooltip.removeFrom(gridGroup);
            }
        });
    }
    gridGroup.on('add', function() {
        localStorage.setItem("base", "grid");
        conditionallyRenderTooltips();
    });
    map.on('zoomend', conditionallyRenderTooltips);
    map.on('moveend', conditionallyRenderTooltips);

    function populateMap() {
        if (baseSelection == "retina") {
            retinaBase.addTo(map);
        } else if (baseSelection == "grid") {
            gridGroup.addTo(map);
        } else {
            defaultBase.addTo(map);
        }
    }

    var gridLabel = (geo.useImperialUnits() ? "300ft" : "100m") + " grid (No-Data)";
    var baseLayers = {
        "Default": defaultBase,
        "Retina (High-Data)": retinaBase
    };
    baseLayers[gridLabel] = gridGroup;

    var systemsLayer = L.layerGroup();
    var stationLayer = L.layerGroup();
    var bikeLayer = L.layerGroup().addTo(map);
    var previewLayer = null;

    var controls = L.control.layers(baseLayers, [], {
        "position": "bottomleft"
    }).addTo(map);

    var $systemList = $("#system-list");
    var oldCenter = null;
    var oldZoom = null;
    var systemZoom = 6;
    $toggle.click(function() {
        if ($toggle.hasClass("active")) {
            stationLayer.addTo(map);
            bikeLayer.addTo(map);
            systemsLayer.remove();
            map.setView(oldCenter, oldZoom);
            $toggle.removeClass("active");
            $systemList.hide();
            if (previewLayer) {
                previewLayer.remove();
            }
            $stationList.show();
        } else {
            stationLayer.remove();
            bikeLayer.remove();
            systemsLayer.addTo(map);
            oldCenter = map.getCenter();
            oldZoom = map.getZoom();
            map.setZoom(systemZoom);
            $toggle.addClass("active");
            $systemList.show();
            $stationList.hide();
            document.getElementById("content-scroll-inner").scrollTop = 0;
        }
    });

    function systemSearch() {
        var value = $(this).val();
        var i = 0;
        $(".station", $systemList).each(function() {
            if (value && $(this).text().toLowerCase().indexOf(value.toLowerCase()) < 0) {
                $(this).hide();
            } else {
                $(this).show();
                i++;
            }
        });
        $("#system-count").text(i + " systems available");
    }
    $("#system-search").change(systemSearch);

    if ("geolocation" in navigator) {
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
        }, function(error) {
            switch (error.code) {
            case error.PERMISSION_DENIED:
                reportError("Please enable access to your device's location.");
                break;
            case error.POSITION_UNAVAILABLE:
                reportError("Location information is unavailable.");
                break;
            case error.TIMEOUT:
                reportError("Geolocation timed out.");
                break;
            case error.UNKNOWN_ERROR:
            default:
                reportError("Unknown geolocation error: " + e.message);
                break;
            }
        }, geo_options);
    } else {
        reportError("Geolocation not supported!");
    }

    function determineSystem() {
        var lat = currentPosition.coords.latitude;
        var lon = currentPosition.coords.longitude;
        timerStart("system-list");
        $.get("/systems", function(response, status, xhr) {
            timerEnd("system-list", xhr);
            var systems = pivot(response);
            var nearbySystems = geo.nearby(lat, lon, systems);
            var system = nearbySystems[0];
            var override = window.location.hash;
            for (var i in nearbySystems) {
                var nearbySystem = nearbySystems[i];
                var selector = ' <button class="system-preview" data-id="' + nearbySystem.id + '" data-name="' + nearbySystem.name + '" data-lat="' + nearbySystem.lat + '" data-lon="' + nearbySystem.lon + '">view</button>';
                if (nearbySystem.distance < 50000) {
                    if (localStorage.getItem('system') === nearbySystem.id) {
                        system = nearbySystem;
                        selector += " <button disabled>use</button>";
                    } else {
                        selector += ' <button class="system-select" data-id="' + nearbySystem.id + '">use</button>';
                    }
                }
                if (override === "#" + nearbySystem.id) {
                    // manual override 
                    system = nearbySystem;
                    map.setView([nearbySystem.lat, nearbySystem.lon], map.getZoom());
                }
                var emoji = "&#x1F307;";
                var isoMatch = nearbySystem.city.match(/, ([A-Z]{2})$/);
                if (isoMatch) {
                    var emojiFlag = emojiFlags.countryCode(isoMatch[1]);
                    if (emojiFlag) {
                        emoji = emojiFlag.emoji;
                    }
                }
                var systemMarker = L.circleMarker([nearbySystem.lat, nearbySystem.lon], {
                    radius: 10,
                    weight: 1,
                    dashArray: "2, 2",
                    lineCap: "butt",
                    fillColor: "rgb(253,77,2)",
                    fillOpacity: 0.3,
                    color: "rgb(253,77,2)",
                    opacity: 1.0
                });
                systemMarker.bindTooltip("<strong>" + nearbySystem.city + " " + emoji + "</strong><br>" + nearbySystem.name);
                systemMarker.addTo(systemsLayer);
                var distance = geo.getDistanceString(nearbySystem.distance);
                var bearing = geo.cardinalDirection(nearbySystem.bearing);
                var $systemRow = $("<div class='station'><div class='station-body'><div class='health station-cell'>" + emoji + "</div><div class='station-cell'><div class='name'>" + nearbySystem.city + selector + "</div>" + "<div class='detail'>" + distance + " " + bearing + " | " + nearbySystem.name + "</div></div></div></div></div>");
                $systemRow.click((function(selectedMarker) {
                    return function(e) {
                        if (e.target.nodeName == "BUTTON") {
                            return;
                        }
                        systemsLayer.addTo(map);
                        if (previewLayer) {
                            previewLayer.remove();
                        }
                        map.setView(selectedMarker.getLatLng(), systemZoom);
                        markerAnimation(selectedMarker);
                    }
                })(systemMarker));
                $systemList.append($systemRow);
            }
            systemSearch();
            $(".system-select").click(function() {
                localStorage.setItem('system', $(this).attr('data-id'));
                window.location.reload();
            });
            $(".system-preview").click(function() {
                var systemId = $(this).attr('data-id');
                var systemName = $(this).attr('data-name');
                var systemLat = parseFloat($(this).attr('data-lat'));
                var systemLon = parseFloat($(this).attr('data-lon'));
                if (previewLayer) {
                    previewLayer.remove();
                }
                $.get("/systems/" + systemId + "/info", function(response, status, xhr) {
                    previewLayer = L.layerGroup();
                    L.setOptions(previewLayer, {
                        attribution: systemName
                    });
                    response.stations = pivot(response.stations);
                    var coords = [];
                    for (var i in response.stations) {
                        var station = response.stations[i];
                        systemLat += station.lat;
                        systemLon += station.lon;
                        var marker = L.circleMarker([station.lat, station.lon], {
                            radius: 5,
                            color: "rgb(253,77,2)",
                            fillColor: '#fff',
                            weight: 5,
                            fillOpacity: 1.0
                        });
                        marker.bindTooltip(readableName(station.name), {
                            offset: [10, 0],
                            direction: 'right'
                        });
                        marker.addTo(previewLayer);
                        coords.push([station.lat, station.lon]);
                    }
                    systemsLayer.remove();
                    previewLayer.addTo(map);
                    if (response.stations) {
                        map.fitBounds(L.latLngBounds(coords));
                    } else {
                        // fall back on system center
                        map.setView([systemLat, systemLon], 13);
                    }
                });
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
                interactive: false
            });
            L.setOptions(stationLayer, {
                attribution: system.name
            });
            stationLayer.addTo(map);
            youMarker.addTo(map);
            if (!override && system.distance > 50000) {
                $stationList.empty();
                $("#content-scroll-inner").prepend('<div class="message">No bikeshare system with public feed nearby!</div>');
                populateMap();
                $toggle.trigger('click');
            } else {
                systemId = system.id;
                timerStart("system-info");
                $.get("/systems/" + systemId + "/info", function(response, status, xhr) {
                    timerEnd("system-info", xhr);
                    response.stations = pivot(response.stations);
                    response.stationMap = {}
                    for (var i in response.stations) {
                        var station = response.stations[i];
                        var stationId = station.id;
                        response.stationMap[station.id] = station;
                        var radius = desktop ? 12 : 10;
                        var marker = L.circleMarker([station.lat, station.lon], {
                            radius: radius,
                            color: "rgb(253,77,2)",
                            fillColor: "rgb(253,77,2)",
                            weight: 2,
                            fillOpacity: 1.0
                        });
                        markerMap[stationId] = marker;
                        marker.bindPopup(station.name, {
                            offset: [0, -radius]
                        });
                        marker.addTo(stationLayer);
                        var pointsIcon = L.divIcon({
                            className: 'points-icon'
                        });
                        var pointsMarker = L.marker([station.lat, station.lon], {
                            icon: pointsIcon,
                            interactive: false
                        });
                        marker.pointsMarker = pointsMarker;
                        var tooltip = L.tooltip({
                            pane: 'overlayPane',
                            permanent: true,
                            offset: [radius + 2, 0],
                            direction: 'right',
                            className: 'grid-label'
                        }).setLatLng(marker.getLatLng()).setContent(readableName(station.name));
                        tooltip.addTo(tooltipGroup);
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
    }).on("click", ".location-toggle", function() {
        var stationId = $(this).attr("data-id");
        var type = $(this).attr("data-type");
        var value = localStorage.getItem("fave_" + systemId + "_" + type);
        if (value == stationId) {
            localStorage.removeItem("fave_" + systemId + "_" + type);
        } else {
            localStorage.setItem("fave_" + systemId + "_" + type, stationId);
            alert(type + " is set.");
        }
        draw();
    });

    function getFavorites() {
        var faves = localStorage.getItem("fave_" + systemId);
        if (faves) {
            faves = JSON.parse(faves);
            var home = localStorage.getItem("fave_" + systemId + "_home");
            if (home) {
                faves[home] = 2;
            }
            var work = localStorage.getItem("fave_" + systemId + "_work");
            if (work) {
                faves[work] = 3;
            }
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
                    var pointsIcon = L.divIcon({
                        html: points(station.pts),
                        className: 'points-icon'
                    });
                    marker.pointsMarker.setIcon(pointsIcon);
                    if (station.pts) {
                        marker.pointsMarker.addTo(stationLayer);
                    }
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
                        weight: station.alerts.length > 0 ? 4 : 2,
                        fillColor: fillColor
                    });
                    var favorite = "&#x2605;";
                    if (favorites[station.id]) {
                        favorite = "&#x2606;";
                    }
                    marker.setPopupContent("<strong>" + station.name + "</strong><br>" + bikes + " bikes " + docks + " docks" + alertsRows(station.alerts) + "<br><button class='favorite-toggle' data-id='" + station.id + "'>" + favorite + "</button><button class='location-toggle' data-type='home' data-id='" + station.id + "'>&#x1F3E0;</button><button class='location-toggle' data-type='work' data-id='" + station.id + "'>&#x1F3E2;</button>")
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
                        marker.bindTooltip(bike.name);
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
            if (delta > span && isFront) {
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

    function markerAnimation(marker) {
        if (marker.animationTimer) {
            return;
        }
        var originalRadius = marker.options.radius;
        var pct = 0;
        marker.animationTimer = setInterval(function() {
            marker.setStyle({
                radius: originalRadius + originalRadius / 2 * (1 - pct)
            });
            pct += 0.1;
            if (pct >= 1.0) {
                clearInterval(marker.animationTimer);
                marker.animationTimer = null;
            }
        }, 50);
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
        var distance = geo.getDistanceString(station.distance);
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
        var favoriteStatus = favorites[station.id];
        if (favoriteStatus == 3) {
            favorite = "&#x1F3E2; ";
        } else if (favoriteStatus == 2) {
            favorite = "&#x1F3E0; ";
        } else if (favoriteStatus == 1) {
            favorite = "&#x2605; ";
        }

        return "<div class='station' data-id='" + station.id + "'><div class='station-body'>" + "<div class='health station-cell'><progress value=" + station.bikes + " max=" + (station.bikes + station.docks) + "></progress></div><div class='station-cell'><div class='name'>" + favorite + station.name + "</div>" + "<div class='detail'>" + pad(station.bikes) + " bikes" + bikePoints + " | " + pad(station.docks) + " docks" + dockPoints + " | " + distance + " " + bearing + " | " + lastMod + "</div>" + alerts + "</div></div></div>";
    }

    function commuteStationRow(station, favorites) {
        var bikePoints = "";
        var dockPoints = "";
        var pts = station.pts;
        if (pts < 0) {
            bikePoints = ", <span class='points-pick'>" + (-pts) + "pts</span>";
        } else if (pts > 0) {
            dockPoints = ", <span class='points-drop'>" + pts + "pts</span>";
        }

        var favorite = "";
        var favoriteStatus = favorites[station.id];
        if (favoriteStatus == 3) {
            favorite = "&#x1F3E2; ";
        } else if (favoriteStatus == 2) {
            favorite = "&#x1F3E0; ";
        }
        return "<div class='station' data-id='" + station.id + "'><div class='station-body'>" + "<div class='station-cell'><progress value=" + station.bikes + " max=" + (station.bikes + station.docks) + "></progress></div><div class='station-cell'><strong>" + favorite + station.name + "</strong> " + bikePoints + dockPoints + "</div></div></div>";
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
            if (effectiveStations.length === 0 && filter == "fave") {
                $stationList.html("<p class='message'>No Favorites<br><em>Click a station on map to mark it as favorite.</em></p>");
            } else {
                $stationList.empty();

                function renderStations($elem, nearestStations, renderRow) {
                    for (var i in nearestStations) {
                        var station = nearestStations[i];
                        var $row = $(renderRow(station, favorites));
                        $row.click(function() {
                            var marker = markerMap[$(this).attr('data-id')];
                            map.setView(marker.getLatLng(), map.getZoom());
                            markerAnimation(marker);
                        });
                        $elem.append($row);
                    }
                }


                if ($commute.hasClass("active")) {
                    var home = localStorage.getItem("fave_" + systemId + "_home");
                    var work = localStorage.getItem("fave_" + systemId + "_work");
                    if (home && work) {
                        home = markerMap[home].getLatLng();
                        work = markerMap[work].getLatLng();

                        var radius = geo.delta(home.lat, home.lng, work.lat, work.lng).distance / 3;

                        var nearbyStations = geo.nearby(lat, lon, effectiveStations, 25);
                        var homeStations = [];
                        var workStations = [];

                        for (var i in effectiveStations) {
                            var station = effectiveStations[i];
                            if (geo.delta(home.lat, home.lng, station.lat, station.lon).distance < radius) {
                                homeStations.push(station);
                            }
                            if (geo.delta(work.lat, work.lng, station.lat, station.lon).distance < radius) {
                                workStations.push(station);
                            }
                        }

                        var $commuteSplit = $("<div class='commute-split' />");
                        var $commuteHome = $("<div class='commute-split-cell'><div class='commute-header'>&#x1F3E0; Near Home</div></div>");
                        var $commuteWork = $("<div class='commute-split-cell'><div class='commute-header'>&#x1F3E2; Near Work</div></div>");

                        renderStations($commuteHome, geo.nearby(lat, lon, homeStations, 15), commuteStationRow);
                        renderStations($commuteWork, geo.nearby(lat, lon, workStations, 15), commuteStationRow);
                        $stationList.append($commuteSplit.append($commuteHome).append($commuteWork));
                    } else {
                        $stationList.html("<p class='message'>Home &amp; Work not set<br><em>Click the closest stations to your home and work on map to mark them.</em></p>");
                    }

                } else {
                    var nearbyStations = geo.nearby(lat, lon, effectiveStations, 25);
                    renderStations($stationList, nearbyStations, stationRow);
                }
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
