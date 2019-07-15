// modules and libraries
const utils = require('./lib/utils.js')
const docutils = require('./lib/docutils.js')
const tableutils = require('./lib/tableutils.js')
const queryutils = require('./lib/queryutils.js')
const replutils = require('./lib/replicatorutils.js')
const pkg = require('./package.json')
const debug = require('debug')(pkg.name)
const morgan = require('morgan')
const url = require('url')

// incoming environment variables vs defaults
const defaults = require('./lib/defaults.js')

// PostgreSQL Client
const { Client } = require('pg')
const client = new Client()

// write a document to the database
const writeDoc = async (databaseName, id, doc) => {
  const preparedQuery = docutils.prepareInsertSQL(databaseName, id, doc)
  return client.query(preparedQuery.sql, preparedQuery.values)
}

// look in the database for new replication jobs
const lookForNewReplications = async () => {
  const sql = replutils.prepareFindNewJobsSQL()
  try {
    const data = await client.query(sql)
    if (data.rows.length === 0) {
      debug('No new replication jobs')
    } else {
      debug(data.rows.length + ' new replication jobs')
      for (var i = 0; i < data.rows.length; i++) {
        const row = data.rows[i]
        const doc = docutils.processResultDoc(row)
        startReplication(doc)
      }
    }
  } catch (e) {
    debug(e)
  }
}

// start replication job
const startReplication = async (job) => {
  const shortJobId = job._id.substr(0, 6) + '..'
  debug('Starting replication job ' + shortJobId)
  job.state = job._i1 = 'running'
  try {
    await writeDoc('_replicator', job._id, job)
  } catch (e) {
    debug(e)
  }
}

// main
const main = async () => {
  try {
    // connect to PostgreSQL
    await client.connect()

    // check for new replications every 30 seconds
    setInterval(lookForNewReplications, 30 * 1000)
    await lookForNewReplications()
  } catch (e) {
    debug(e)
    console.error('Cannot connect to PostgreSQL')
  }
}

main()
