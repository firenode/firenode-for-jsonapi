
require('org.pinf.genesis.lib').forModule(require, module, function (API, exports) {

	var Context = function () {

		var self = this;

		var layers = [];

		function mergeAcrossLayers (propertySelector, overridesForSubLayers) {
			var value = null;

			function mergeValues (baseValue, overlayValue) {
				if (baseValue === null) {
					baseValue = overlayValue;
				} else
				if (baseValue === overlayValue) {
					// same value
				} else {
					baseValue = API.DEEPMERGE(baseValue, overlayValue);
				}
				return JSON.parse(JSON.stringify(baseValue));
			}

			function getMatchForLayer (layer) {
				var configMatch = API.JP({
					json: layer,
					path: "$." + propertySelector,
					resultType: 'all'
				});

				if (configMatch.length === 0) return null;

				if (configMatch.length > 1) {
					console.log("configMatch", configMatch);
					console.log("propertySelector", propertySelector);
					throw new Error("We got more than one result which should never happen!");
				}

				return configMatch[0];
			}

			var layersLength = layers.length;
			layers.forEach(function (layer, i) {
				if (
					overridesForSubLayers &&
					i === (layersLength - 1)
				) {
					overridesForSubLayers.forEach(function (overrideForSubLayers) {
						if (typeof self[overrideForSubLayers] === "undefined") return;

						var overrides = {};
						overrides[propertySelector] = {};
						Object.keys(value).forEach(function (id) {

							if (!value[id][overrideForSubLayers]) {
								value[id][overrideForSubLayers] = {};
							}
							value[id][overrideForSubLayers] = mergeValues(value[id][overrideForSubLayers], self[overrideForSubLayers]);
						});
					});

				}
				var match = getMatchForLayer(layer);
				if (!match) return;
				value = mergeValues(value, match.value);
			});

			return value;
		}

		self.addLayer = function (context) {
			if (!context) return;
			layers.push(context);
		}

		self.clone = function () {

			var context = new Context();

			layers.forEach(context.addLayer);

			return context;
		}

		// TODO: Document schema and rules here and eventually feed via schema.

		Object.defineProperty(self, "request", {
			get: function () {
				return mergeAcrossLayers("request");
			}
		});
		Object.defineProperty(self, "routes", {
			get: function () {
				return mergeAcrossLayers("routes", [
					"config"
				]);
			}
		});
		Object.defineProperty(self, "hosts", {
			get: function () {
				return mergeAcrossLayers("hosts") || [];
			}
		});
		Object.defineProperty(self, "config", {
			get: function () {
				return mergeAcrossLayers("config");
			}
		});
		Object.defineProperty(self, "allow", {
			get: function () {
				return mergeAcrossLayers("allow");
			}
		});
	}


	var Server = exports.Server = function (contextProperties) {

		var self = this;

		var context = new Context();

		context.addLayer(contextProperties);

		self._makeContext = function (contextProperties) {

			var ctx = context.clone();

			ctx.addLayer(contextProperties);

			API.EXTEND(false, ctx, self);

			return ctx;
		}
	}


	var routeExpressions = {};
	function routeExpressionForRouteId (routeId) {
		if (routeExpressions[routeId]) {
			return routeExpressions[routeId];
		}
		routeExpressions[routeId] = new RegExp("^" + API.REGEXP_ESCAPE(routeId));
		return routeExpressions[routeId];
	}

	Server.prototype.attachToUri = function (uri, errorHandler) {
		var self = this;
		var routes = self.routes;
		var routeIds = Object.keys(routes);
		routeIds.sort();
		routeIds.forEach(function (routeId) {
			if (!routeExpressionForRouteId(routeId).test(uri)) return
			self.addLayer(routes[routeId]);
		});
		if (!self.allow) {
			errorHandler(403, "No accessible route for uri '" + uri + "'!");
			return false;
		}
		return true;
	}

	Server.prototype.attachToRequest = function (req, res) {

		var hostParts = req.headers.host.split(":");

		req._FireNodeContext = this._makeContext({
			request: {
				hostname: hostParts[0],
				port: hostParts[1] || "",
				path: req.url
			}
		});

		var serviceContext = req._FireNodeContext.hosts[req._FireNodeContext.request.hostname];
		if (!serviceContext) {
			return res.status(404).send("Hostname '" + req._FireNodeContext.request.hostname + '" not configured!');
		}

		req._FireNodeContext.addLayer(serviceContext);

		return req._FireNodeContext.attachToUri(req._FireNodeContext.request.path, function (code, message) {
			var err = {
				code: code,
				message: message
			};
			console.error("Error for path '" + req._FireNodeContext.request.path + "':", err);
			return res.status(code).send(message);
		});
	}

	Server.prototype.attachToMessage = function (message) {

		message._FireNodeContext = this._makeContext();

		return true;
	}

	Server.prototype.attachToSocket = function (socket) {

		var hostParts = socket.client.request.headers.host.split(":");

		socket._FireNodeContext = this._makeContext({
			request: {
				hostname: hostParts[0],
				port: hostParts[1] || "",
				path: socket.client.request.url
			}
		});

		var serviceContext = socket._FireNodeContext.hosts[socket._FireNodeContext.request.hostname];
		if (!serviceContext) {
			return res.status(404).send("Hostname '" + socket._FireNodeContext.request.hostname + '" not configured!');
		}

		socket._FireNodeContext.addLayer(serviceContext);

		return socket._FireNodeContext.attachToUri(socket._FireNodeContext.request.path, function (code, message) {
			var err = {
				code: code,
				message: message
			};
			socket.emit("error", err);
			console.error("Error for path '" + socket._FireNodeContext.request.path + "':", err);
			return socket.end();
		});
	}

	Server.prototype.attachToServer = function (server) {

		server._FireNodeContext = this._makeContext({
			service: {
				hostname: "*",
				port: "*"
			}
		});

		return true;
	}

});
