const sanitise = (str) => {
  return str.replace(/[^a-zA-Z0-9\-_]/, '')
}

const validID = (str) => {
  // valid as long as it contains no dodgy characters
  // and doesn't start with an underscore
  return str === sanitise(str) && !str.startsWith('_')
}

const validDatabaseName = (str) => {
  return validID(str)
}

module.exports = {
  sanitise,
  validID,
  validDatabaseName
}
