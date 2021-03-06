/*
 *  Copyright 2012 Intel Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

var db = require('ripple/db'),
    event = require('ripple/event'),
    constants = require('ripple/constants'),
    _volume  = document.getElementById(constants.BATTERY.VOLUME),
    _volumeLabel  = document.getElementById(constants.BATTERY.VOLUME + "-label"),
    _charging = document.getElementById(constants.BATTERY.CHARGING),
    _battery = {
        volume: 600,
        level:  1.0,
        timerId: null,
        charge: function (isStart, isCharge, callback) {
            var currentVolume,
                checkValue = function () {
                    if (_battery.level < 0 || _battery.level > 1.0 || !isStart) {
                        clearInterval(_battery.timerId);
                        _battery.timerId = null;
                        if (_battery.level < 0)
                            _battery.level = 0;
                        else if (_battery.level > 1.0)
                            _battery.level = 1.0;
                    }
                };

            if (isStart && !_battery.timerId) {
                _battery.timerId = setInterval(function () {
                    currentVolume = isCharge ? _battery.level * _battery.volume + 1 : _battery.level * _battery.volume - 1;
                    _battery.level = currentVolume / _battery.volume;
                    checkValue();
                    return callback && callback();
                }, 1000);
            }
            checkValue();
            return callback && callback();
        }
    };

function _triggerEvent(chargingStatus, chargingTime, dischargingTime, level, type) {
    var status = {
        charging: chargingStatus,
        chargingTime: chargingTime,
        dischargingTime: dischargingTime,
        level: level,
        type: type
    };
    event.trigger("BatteryEvent", [status]); // for w3c battery api
    // for tizen systeminfo api
    if (type === "levelchange") {
        event.trigger("BatteryLevelChanged", [level]);
    }
    if (type === "chargingchange") {
        event.trigger("BatteryChargingChanged", [status]);
    }
}

function _updateLevelIcons() {
    var colors = ["black", "black", "black", "black", "black", "black", "#404040", "#606060", "#808080", "#b0b0b0", "#ffffff", "#ffffff", "#ffffff", "#ffffff", "#ffffff", "#ffffff"],
        colorIndex = 10 - Math.round(_battery.level * 10),
        index;

    //map the battery level to the color range
    for (index = 0 ; index <= 5 ; index++) {
        $("#block" + index).css("backgroundColor", colors[colorIndex]);
        colorIndex++;
    }
}

function _setVolumeReadOnly(flag) {
    if (flag) {
        $("#" + constants.BATTERY.VOLUME).hide();
        $("#" + constants.BATTERY.VOLUME + "-label").show();
    } else {
        $("#" + constants.BATTERY.VOLUME).show();
        $("#" + constants.BATTERY.VOLUME + "-label").hide();
    }
}

function _startDischarging() {
    var remainVolume = 0;

    if ($("#simulate-low-battery #low-battery-remain-time").val() <= 0) {
        $("#simulate-low-battery #low-battery-remain-time").val(0);
    }
    remainVolume = Number($("#simulate-low-battery #low-battery-remain-time").val());
    if ($("#simulate-low-battery #low-battery-start-at").val() > 100) {
        $("#simulate-low-battery #low-battery-start-at").val(100);
    }
    if ($("#simulate-low-battery #low-battery-start-at").val() <= 0) {
        $("#simulate-low-battery #low-battery-start-at").val(0);
    }
    _battery.level = $("#simulate-low-battery #low-battery-start-at").val() / 100.0;
    if (_battery.level === 0 || remainVolume === 0) {
        $("#simulate-low-battery").dialog("close");
        _stopDischarging();
        return;
    }
    _setVolumeReadOnly(true);
    if (_charging.checked) {
        _charging.checked = false;
        _battery.charge(false);
    }

    _charging.disabled = true;
    $("#remaining-time-label").html("Remaining Time to empty (seconds)");
    $("#charging-state").html("Plugged in?");

    $("#remain-time").show();
    _battery.volume = remainVolume / _battery.level;
    _volumeLabel.innerText = (_battery.level * 100).toFixed(2);
    _battery.charge(true, false, function () {
        _volumeLabel.innerText = (_battery.level * 100).toFixed(2);
        _volume.value = (_battery.level * 100).toFixed(2);
        changeBatteryVolume();
        $("#remain-time").html(Math.round(_battery.volume * _battery.level) + " Seconds");
        _updateLevelIcons();
        if (_battery.level <= 0.0) {
            _stopDischarging();
        }
    });
    $("#simulate-low-battery").dialog("close");
    $("#simulate-low-battery-btn").hide();
    $("#stop-btn").show();
    _triggerEvent(false, Infinity, Math.round(_battery.volume * _battery.level), _battery.level, "chargingtimechange");
}

function _stopDischarging() {
    _charging.disabled = false;
    _battery.level = _volume.value / 100.0;
    $("#remain-time").hide();
    $("#remain-time").html("");
    $("#remaining-time-label").html("Remaining Time (seconds)");
    _setVolumeReadOnly(false);
    _battery.charge(false);
    $("#simulate-low-battery-btn").show();
    $("#stop-btn").hide();
    _updateLevelIcons();
}

function _setCharging() {
    // update the UI parts
    if (_charging.checked) {
        _battery.volume = 600;
        _battery.level = _volume.value / 100;
        _setVolumeReadOnly(true);
        $("#remain-time").show();
        $("#remaining-time-label").html("Remaining Time to fully charged (seconds)");
        $("#charging-state").html("Plugged in - charging rate 0.17%/second");
        _triggerEvent(true, Math.round(_battery.volume * (1 - _battery.level)), Infinity, _battery.level, "chargingchange");
    } else {
        _battery.level = _volume.value / 100.0;
        _updateLevelIcons();
        $("#remain-time").hide();
        $("#remain-time").html("");
        _setVolumeReadOnly(false);
        $("#remaining-time-label").html("Remaining Time (seconds)");
        $("#charging-state").html("Plugged in?");
        _triggerEvent(false, Infinity, Math.round(_battery.volume * _battery.level), _battery.level, "chargingchange");
    }
    // if it's unchecked, the timer will stop in this function call, the UI update blow it
    _battery.charge(_charging.checked, true, function () {
        _volumeLabel.innerText = (_battery.level * 100).toFixed(2);
        _volume.value = (_battery.level * 100).toFixed(2);
        changeBatteryVolume();
        $("#remain-time").html(Math.round(_battery.volume * (1 - _battery.level)) + " Seconds");    //show current remain time
        _updateLevelIcons();
    });
}

function changeBatteryVolume() {
    if (_volume.value < 0)
        _volume.value = 0;
    else if (_volume.value > 100)
        _volume.value = 100;

    _battery.level = _volume.value / 100.0;
    if (_charging.checked === true) {
        _triggerEvent(true, Math.round(_battery.volume * (1 - _battery.level)), Infinity, _battery.level, "levelchange");
    } else {
        _triggerEvent(false, Infinity, Math.round(_battery.volume * _battery.level), _battery.level, "levelchange");
    }
    db.save(constants.BATTERY.VOLUME, _volume.value);
    _updateLevelIcons();
}

function initBattery() {
    $("#" + constants.BATTERY.CHARGING).bind("change", _setCharging);

    $("#simulate-low-battery-btn").bind("click", function () {
        $("#simulate-low-battery").dialog("open");
    });

    $("#simulate-low-battery-cancel").bind("click", function () {
        $("#low-battery-start-at").val = 20;  //UI initialize
        $("#low-battery-remain-time").val = 1200;
        $("#simulate-low-battery").dialog("close");
    });

    $("#simulate-low-battery-start").bind("click", _startDischarging);
    $("#stop-btn").bind("click", _stopDischarging);

    $("#" + constants.BATTERY.VOLUME).bind("change", function () {
        changeBatteryVolume();
    });

    _charging.checked = false;
    _battery.level = db.retrieve(constants.BATTERY.VOLUME) / 100.0;
    if (isNaN(_battery.level)) {
        _battery.level = 1;
    }
    _volume.value = (_battery.level * 100).toFixed(2);
    _updateLevelIcons();
    $("#simulate-low-battery").dialog({
        resizable: false,
        draggable: true,
        modal: true,
        autoOpen: false,
        position: 'center',
        minWidth: '460',
        minHeight: '240'
    });
}

module.exports = {
    panel: {
        domId: "power-container",
        collapsed: true,
        pane: "left",
        titleName: "Power Manager",
        display: true
    },

    initialize: function () {
        initBattery();
    }
};
