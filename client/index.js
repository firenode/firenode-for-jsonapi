

var Client = exports.Client = function () {

	console.log("init firenode client!");


var log = ['test'];
var obj = {
  get latest () {
    if (log.length == 0) return undefined;
    return log[log.length - 1]
  }
}
console.log (obj.latest); // Will return "test!!!!"


}

