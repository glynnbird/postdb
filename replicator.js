// modules and libraries
const docutils = require('./lib/docutils.js')
const replutils = require('./lib/replicatorutils.js')
const tableutils = require('./lib/tableutils.js')
const pkg = require('./package.json')
const defaults = require('./lib/defaults.js')
const debug = require('debug')(pkg.name)
const url = require('url')

// PostgreSQL Client
const { Client } = require('pg')
const client = new Client()

// write a document to the database
const writeDoc = async (databaseName, id, doc, clusterid) => {
  const preparedQuery = docutils.prepareInsertSQL(databaseName, id, doc, clusterid)
  return client.query(preparedQuery.sql, preparedQuery.values)
}

// look in the database for new replication jobs
const lookForNewReplications = async (firstTime) => {
  let sql

  // when running this for the first time we want new jobs
  // and running jobs (jobs that were running when the
  // replicator stopped)
  if (firstTime) {
    sql = replutils.prepareFindNewOrRunningJobsSQL()
  } else {
    sql = replutils.prepareFindNewJobsSQL()
  }
  try {
    const data = await client.query(sql)
    if (data.rows.length === 0) {
    } else {
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
  job.state = job._i1 = 'running'
  let parsedUrl
  try {
    // parse the source url
    parsedUrl = new url.URL(job.source)
    if (!parsedUrl) {
      throw (new Error('Invalid source URL'))
    }
    // set the status to running
    await writeDoc('_replicator', job._id, job, defaults.clusterid)
  } catch (e) {
    debug(e)
    job.state = job._i1 = 'error'
    writeDoc('_replicator', job._id, job, defaults.clusterid)
    return
  }

  // create target if necessary
  try {
    // if the target database needs creating
    if (job.create_target) {
      const sql = tableutils.prepareCreateTableTransaction(job.target)
      for (var i = 0; i < sql.length; i++) {
        await client.query(sql[i])
      }
    }
  } catch (e) {
    debug('Target already present')
    await client.query('ROLLBACK')
  }

  // create Nano object
  const Nano = require('nano')
  const sourceUrl = parsedUrl.href.replace(parsedUrl.pathname, '')
  const nano = Nano(sourceUrl)
  const db = parsedUrl.pathname.replace(/^\//, '')
  const ChangesReader = require('changesreader')
  const changesReader = new ChangesReader(db, nano.request)

  // run replication
  let worker
  console.log(shortJobId + ' starting  from ' + job.seq.substr(0, 10))
  const opts = {
    batchSize: 5000,
    since: job.seq,
    includeDocs: true,
    wait: true
  }
  if (job.exclude.length > 0) {
    opts.qs = { exclude: job.exclude }
  }

  // decide whether to use continuous or one-off
  if (job.continuous) {
    worker = changesReader.start(opts)
  } else {
    worker = changesReader.get(opts)
  }

  // listen for changes events
  worker
    .on('batch', (b, callback) => {
      console.log(shortJobId + ' ' + b.length + ' changes')
      try {
        const write = async () => {
          let docCount = 0
          await client.query('BEGIN')
          for (var i = 0; i < b.length; i++) {
            const clusterid = b[i].clusterid || defaults.clusterid
            if (b.deleted) {
              const sql = docutils.prepareDeleteSQL(job.target, b[i].id, clusterid)
              await client.query(sql.sql, sql.values)
              docCount++
            } else {
              if (!b[i].id.match(/^_design/)) {
                await writeDoc(job.target, b[i].id, b[i].doc, clusterid)
                docCount++
              }
            }
          }
          job.doc_count += docCount
          await writeDoc('_replicator', job._id, job, defaults.clusterid)
          await client.query('COMMIT')
        }
        write().then(callback)
      } catch (e) {
        client.query('ROLLBACK')
        debug(e)
      }
    }).on('seq', (s) => {
      job.seq = s
      // will be written on next batch
    }).on('error', (e) => {
      debug('changesreader error', e)
      job.state = job._i1 = 'error'
      writeDoc('_replicator', job._id, job)
    }).on('end', (e) => {
      setTimeout(function () {
        console.log(shortJobId + ' ended')
        job.state = job._i1 = 'completed'
        writeDoc('_replicator', job._id, job)
      }, 1000)
    })
}

// main
const main = async () => {
  try {
    // connect to PostgreSQL
    await client.connect()

    // check for new replications every 30 seconds
    setInterval(lookForNewReplications, 30 * 1000)
    await lookForNewReplications(true)
  } catch (e) {
    debug(e)
    console.error('Cannot connect to PostgreSQL')
  }
}

main()
