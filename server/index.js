
require('org.pinf.genesis.lib').forModule(require, module, function (API, exports) {


	// TODO: Hookup to memcached.
	var SessionStore = function () {
		this.sessions = {};
	}
	SessionStore.prototype.set = function (sessionToken, value) {
		this.sessions[sessionToken] = value;
		// TODO: Remove session when expired (x time after last modification).
console.log("Set session in store", sessionToken, value);
	}
	SessionStore.prototype.get = function (sessionToken) {
console.log("Get session from store", sessionToken, this.sessions[sessionToken] || null);
		return this.sessions[sessionToken] || null;
	}

	var sessionStore = new SessionStore();


	var Context = function () {

		var self = this;

		var layers = [];
		const RESET_OBJECT = "RESET-OBJECT-CONSTANT";

		function mergeAcrossLayers (propertySelector) {
			var value = null;

			function mergeValues (baseValue, overlayValue) {
				if (baseValue === null) {
					baseValue = overlayValue;
				} else
				if (baseValue === overlayValue) {
					// same value
				} else {
					// Ensure variables stay in order of top config object.
					// TODO: Use arrays and do not rely on property order in object.
/*
					if (typeof overlayValue === "object") {
						for (var name in overlayValue) {
							if (typeof baseValue[name] === "undefined") {
								baseValue[name] = null;
							}
						}
					}
*/
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
				var match = getMatchForLayer(layer);
				if (!match) return;

				if (match.value === RESET_OBJECT) {
					value = {};
				} else {
					value = mergeValues(value, match.value);
				}
			});

			return value;
		}

		self.addLayer = function (context) {
			if (!context) return;
			layers.push(context);
			if (context.session) {
				self.emit("session-changed");
			}
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
				var routes = mergeAcrossLayers("routes");
				var config = self.config;
				for (var routeId in routes) {
					routes[routeId].config = API.DEEPMERGE(config, routes[routeId].config || {});
				}
				return routes;
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
		Object.defineProperty(self, "session", {
			get: function () {
				return mergeAcrossLayers("session");
			}
		});
		self.initSession = function () {
			// We initialize the session by accessing the 'sessionToken' property.
			this.sessionToken;
		}
		self.resetSession = function () {
			console.log("reset session");
			var sessionToken = API.UUID.v4();
			console.log("init new session token:", sessionToken);
			self.addLayer({
				config: {
					sessionToken: sessionToken
				},
				session: RESET_OBJECT
			});
			self.emit("new-session");
		}

		Object.defineProperty(self, "sessionToken", {
			get: function () {
				function getValue (verify) {
					var config = self.config;

					if (
						config.sessionToken &&
						config.sessionToken !== "<REPLACED-BY-ROUTER>"
					) {
						if (verify) {
							sessionStore.set(config.sessionToken, self.session);
						}
						return config.sessionToken;
					}

					if (verify) {
						throw new Error("Variable 'config.clientContext.sessionToken' not found after trying to add it!");
					}

					var sessionToken = API.UUID.v4();
					console.log("init new session token:", sessionToken);
					self.addLayer({
						config: {
							sessionToken: sessionToken
						},
						session: {
							createdTime: Date.now()
						}
					});
					self.emit("new-session");

					return getValue(true);
				}
				return getValue();
			}
		});
	}
	Context.prototype = Object.create(API.EVENTS.EventEmitter.prototype);


	var Server = exports.Server = function (contextProperties, initOptions) {

		var self = this;

		self.initOptions = initOptions || {};

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
		if (/^\^/.test(routeId)) {
			routeExpressions[routeId] = new RegExp(routeId.replace(/\//g, "\\/"));
		} else
		if (/\$$/.test(routeId)) {
			routeExpressions[routeId] = new RegExp("^" + API.REGEXP_ESCAPE(routeId.replace(/\$$/, "")) + "$");
		} else {
			routeExpressions[routeId] = new RegExp("^" + API.REGEXP_ESCAPE(routeId));
		}
		return routeExpressions[routeId];
	}

	Server.prototype.attachToUri = function (uri, errorHandler) {
		var self = this;
		var routes = self.routes;
		var routeIds = Object.keys(routes);
		routeIds.sort();
		var lastRouteArg = null;
		var lastMatchingRoute = false;
		routeIds.forEach(function (routeId) {
			if (lastMatchingRoute) return;
			var m = routeExpressionForRouteId(routeId).exec(uri);
			if (!m) return;
			self.addLayer(routes[routeId]);
			lastRouteArg = m[1];
			if (routes[routeId].lastMatchingRoute) {
				lastMatchingRoute = true;
			}
		});
		if (!self.allow) {
			errorHandler(403, "[FireNode] No accessible route for uri '" + uri + "'!");
			return false;
		}
		return lastRouteArg;
	}

	Server.prototype.attachToRequest = function (req, res) {
		var self = this;

		var hostParts = req.headers.host.split(":");

		req._FireNodeContext = self._makeContext({
			request: {
				hostname: hostParts[0],
				port: hostParts[1] || "",
				path: req.url
			}
		});

		var serviceContext = req._FireNodeContext.hosts[req._FireNodeContext.request.hostname];
		if (!serviceContext) {
			res.writeHead(404);
			res.end("[FireNode] Hostname '" + req._FireNodeContext.request.hostname + '" not configured!');
			console.log("[FireNode] Hostname '" + req._FireNodeContext.request.hostname + '" not configured!');
			return false;
		}

		req._FireNodeContext.addLayer(serviceContext);

		var attached = req._FireNodeContext.attachToUri(req._FireNodeContext.request.path, function (code, message) {
			var err = {
				code: code,
				message: message
			};
			console.error("[FireNode] Error for path '" + req._FireNodeContext.request.path + "':", err);
			res.writeHead(404);
			res.end(message);
		});
		// If we did not attach we signal that we should not proceed.
		if (attached === false) {
//console.log("did not attch", req.url);
			return false;
		}

		req._FireNodeContext.on("new-session", function () {
			var config = req._FireNodeContext.config;
			if (
				config.clientContext &&
				config.clientContext.sessionCookieName
			) {
				var cookies = API.COOKIES(req, res);
				cookies.set(config.clientContext.sessionCookieName, config.sessionToken, {
					overwrite: true
				});
			}
		});

		req._FireNodeContext.on("session-changed", function () {
			var config = req._FireNodeContext.config;
			if (
				config.sessionToken &&
				config.sessionToken !== "<REPLACED-BY-ROUTER>"
			) {
				// TODO: Debounce and buffer these calls for 1 sec.
				// TODO: Diff data with existing to see if changed.
				sessionStore.set(config.sessionToken, req._FireNodeContext.session);
			}
		});

		// Route request if declared

		var config = req._FireNodeContext.config;

		if (config) {

//console.log("Found config", req.url, config);

			if (
				config.clientContext &&
				config.clientContext.sessionCookieName
			) {
				var cookies = API.COOKIES(req, res);
//console.log("cookie value for '" + config.clientContext.sessionCookieName + "':", cookies.get(config.clientContext.sessionCookieName));
				if (cookies.get(config.clientContext.sessionCookieName)) {
					var session = sessionStore.get(cookies.get(config.clientContext.sessionCookieName));
					if (session) {
						req._FireNodeContext.addLayer({
							config: {
								sessionToken: cookies.get(config.clientContext.sessionCookieName)
							},
							session: session
						});
						config = req._FireNodeContext.config;
					}
				}
			}

			req._FireNodeContext.initSession();

			return API.Q.fcall(function () {

				function finalizeRoute () {

					var config = req._FireNodeContext.config;

					// Now modify request based on config.

					if (config.externalRedirect) {

						if (req.url === config.externalRedirect) {
							res.writeHead(500);
							res.end("Infinite redirect!");
							// Do not proceed.
							return false
						}

						res.writeHead(302, {
							"Location": config.externalRedirect
						});
						res.end();
						// Do not proceed.
						return false
					} else
					if (config.internalUri) {
						var originalUrl = req.url;
						req.url = config.internalUri;
						if (API.DEBUG) {
							console.log("Set url from '" + originalUrl + "' to '" + req.url + "' based on 'internalUri' route config.");
						}
					}

					return true;
				}

				if (
					config.router &&
					self.initOptions.instances
				) {
					var router = null;

					try {
						var inst = self.initOptions.instances[config.router.impl];
						console.log("self.initOptions.instances", self.initOptions.instances);
						if (!inst || typeof inst.for !== "function") {
							console.error("inst", inst);
							throw new Error("Module implementation for '" + config.router.impl + "' does not export 'for' method!");
						}
						router = inst.for(API);
						if (!router) throw new Error("No router instance mapped");
					} catch (err) {
						console.error("config.router", config.router);
						console.error("self.initOptions", self.initOptions);
						console.error(err.stack);
						throw new Error("Error loading impl '" + config.router.impl + "' from initOptions");
					}

					if (router) {
						try {
							
							console.log("Pass request to router:", config.router.impl);

							return API.Q.when(router.processRequest(req, res, {
								arg: attached
							}), function (responded) {
								if (responded) {
									// Do not proceed.
									return false;
								}

								return finalizeRoute();
							});
						} catch (err) {
							console.error("Error processing request using router '" + config.router.impl + "':", err.stack);
							res.writeHead(500);
							res.end("Internal Server Error");
							// Do not proceed.
							return false;
						}
					}
				}

				return finalizeRoute();
			});
		} else {

//console.log("No config found", config);

		}
		return true;
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
			var err = {
				code: 404,
				message: "[FireNode] Hostname '" + socket._FireNodeContext.request.hostname + '" not configured!'
			};
			console.error("[FireNode] Error for path '" + socket._FireNodeContext.request.path + "':", err);
			try {
				socket.emit("response:error", err);
				socket.close();
			} catch (err) {
				console.error("Error sending error over socket:", err.stack);
			}
			return false;
		}

		socket._FireNodeContext.addLayer(serviceContext);

		return socket._FireNodeContext.attachToUri(socket._FireNodeContext.request.path, function (code, message) {
			var err = {
				code: code,
				message: message
			};
			console.error("[FireNode] Error for path '" + socket._FireNodeContext.request.path + "':", err);
			try {
				socket.emit("response:error", err);
				socket.close();
			} catch (err) {
				console.error("Error sending error over socket:", err.stack);
			}
			return false;
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
