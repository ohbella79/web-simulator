/*
 *  Copyright 2013 Intel Corporation.
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

var t = require('ripple/platform/tizen/2.0/typecast'),
    Notification;

Notification = function (title, content) {
    var notification = {};

    notification.title = title;
    notification.content = content || null;

    this.__defineGetter__("id", function () {
        return undefined;
    });

    this.__defineGetter__("type", function () {
        return "STATUS";
    });

    this.__defineGetter__("postedTime", function () {
        return undefined;
    });

    this.__defineGetter__("title", function () {
        return notification.title;
    });
    this.__defineSetter__("title", function (val) {
        try {
            notification.title = t.DOMString(val);
        } catch (e) {
        }
    });

    this.__defineGetter__("content", function () {
        return notification.content;
    });
    this.__defineSetter__("content", function (val) {
        try {
            notification.content = t.DOMString(val, "?");
        } catch (e) {
        }
    });
};

module.exports = Notification;
