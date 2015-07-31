
const COOKIES = require("js-cookie");


var Client = exports.Client = function (sessionToken, context) {


	COOKIES.set(context.sessionCookieName, sessionToken);

console.log("FIRENODE SESSION CONFIG", context);

}

