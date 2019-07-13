// modules and libraries
const express = require('express')
const utils = require('./lib/utils.js')
const docutils = require('./lib/docutils.js')
const tableutils = require('./lib/tableutils.js')
const queryutils = require('./lib/queryutils.js')
const pkg = require('./package.json')
const debug = require('debug')(pkg.name)
const app = express()
const basicAuth = require('express-basic-auth')
const kuuid = require('kuuid')
const morgan = require('morgan')

// incoming environment variables vs defaults
const defaults = require('./lib/defaults.js')

// JSON parsing middleware
const bodyParser = require('body-parser')
app.use(bodyParser.json())

// Logging middleware
if (defaults.logging !== 'none') {
  app.use(morgan(defaults.logging))
}

// AUTH middleware
if (defaults.username && defaults.password) {
  console.log('NOTE: authentication mode')
  const obj = {}
  obj[defaults.username] = defaults.password
  app.use(basicAuth({ users: obj }))
}

// readonly middleware
const readOnlyMiddleware = require('./lib/readonly.js')(defaults.readonly)
if (defaults.readonly) {
  console.log('NOTE: readonly mode')
}

// PostgreSQL Client
const { Client } = require('pg')
const client = new Client()

// send error
const sendError = (res, statusCode, str) => {
  res.status(statusCode).send({ error: str })
}

// write a document to the database
const writeDoc = async (databaseName, id, doc) => {
  debug('Add document ' + id + ' to database - ' + databaseName)
  const preparedQuery = docutils.prepareInsertSQL(databaseName, id, doc)
  debug(preparedQuery.sql)
  return client.query(preparedQuery.sql, preparedQuery.values)
}

// POST /db/_bulk_docs
// bulk add/update/delete several documents
app.post('/:db/_bulk_docs', async (req, res) => {
  const databaseName = req.params.db
  if (!utils.validDatabaseName(databaseName)) {
    return sendError(res, 400, 'Invalid database name')
  }

  // docs parameter
  const docs = req.body.docs
  if (!docs || !Array.isArray(req.body.docs) || docs.length === 0) {
    return sendError(res, 400, 'Invalid docs parameter')
  }

  // start transaction
  await client.query('BEGIN')
  const response = []

  // process each document
  for (var i in docs) {
    const doc = docs[i]
    let preparedQuery, id

    // if this is a deletion
    if (doc._deleted) {
      id = doc._id || null
      if (!id || !utils.validID(id)) {
        response.push({ ok: false, error: 'missing or invalid _id' })
        continue
      }
      preparedQuery = docutils.prepareDeleteSQL(databaseName, id)
    } else {
      // update or insert
      id = doc._id || kuuid.id()
      if (!utils.validID(id)) {
        response.push({ ok: false, id: id, error: 'invalid _id' })
        continue
      }
      preparedQuery = docutils.prepareInsertSQL(databaseName, id, doc)
    }

    // perform the SQL
    debug(preparedQuery.sql, preparedQuery.values)
    try {
      await client.query(preparedQuery.sql, preparedQuery.values)
      response.push({ ok: true, id: id, rev: '0-1' })
    } catch (e) {
      response.push({ ok: false, id: id, error: 'Dailed to write document' })
    }
  }

  // end transaction
  await client.query('COMMIT')
  res.status(201).send(response)
})

// GET /db/_all_dbs
// get a list of databases (tables)
app.get('/_all_dbs', async (req, res) => {
  try {
    const sql = tableutils.prepareTableListSQL()
    debug(sql)
    const data = await client.query(sql)
    const databases = []
    for (var i in data.rows) {
      const row = data.rows[i]
      databases.push(row.table_name)
    }
    res.send(databases)
  } catch (e) {
    debug(e)
    sendError(res, 404, 'Could not retrieve databases')
  }
})

// GET /db/_all_dbs
// get a list of unique ids
app.get('/_uuids', (req, res) => {
  const count = req.query.count ? JSON.parse(req.query.count) : 1
  if (count < 1 || count > 100) {
    return sendError(res, 400, 'invalid count parameter')
  }
  const obj = {
    uuids: []
  }
  for (var i = 0; i < count; i++) {
    obj.uuids.push(kuuid.id())
  }
  res.send(obj)
})

// POST /db/_purge
// totally delete documents
app.post('/:db/_purge', async (req, res) => {
  const databaseName = req.params.db
  if (!utils.validDatabaseName(databaseName)) {
    return sendError(res, 400, 'Invalid database name')
  }
  try {
    const sql = docutils.preparePurgeTransaction(databaseName, Object.keys(req.body))
    for (var i in sql) {
      const s = sql[i]
      debug(s.sql, s.values)
      await client.query(s.sql, s.values)
    }
    res.send({ purge_seq: null, purged: req.body })
  } catch (e) {
    debug(e)
    sendError(res, 404, 'Could not retrieve databases')
  }
})

// GET /db/changes
// get a list of changes
app.get('/:db/_changes', async (req, res) => {
  const databaseName = req.params.db
  if (!utils.validDatabaseName(databaseName)) {
    return sendError(res, 400, 'Invalid database name')
  }

  // parameter munging
  const since = req.query.since ? req.query.since : '0'
  const includeDocs = req.query.include_docs === 'true'
  let limit
  try {
    limit = req.query.limit ? Number.parseInt(req.query.limit) : null
  } catch (e) {
    return sendError(res, 400, 'Invalid limit parameter')
  }
  if (limit && (typeof limit !== 'number' || limit < 1)) {
    return sendError(res, 400, 'Invalid limit parameter')
  }

  // do query
  const sql = queryutils.prepareChangesSQL(databaseName, since, includeDocs, limit)

  try {
    debug(sql.sql, sql.values)
    const data = await client.query(sql.sql, sql.values)
    const obj = {
      last_seq: '',
      results: []
    }
    let lastSeq = since
    for (var i in data.rows) {
      const row = data.rows[i]
      const thisobj = {
        changes: [{ rev: '0-1' }],
        id: row.id,
        seq: row.ts
      }
      if (row.deleted) {
        thisobj.deleted = true
      }
      if (includeDocs) {
        thisobj.doc = docutils.processResultDoc(row)
      }
      lastSeq = row.ts
      obj.results.push(thisobj)
    }
    obj.last_seq = lastSeq
    res.send(obj)
  } catch (e) {
    debug(e)
    sendError(res, 500, 'Could not fetch changes feed')
  }
})

// GET /db/_query
// query one of the defaults.indexes
app.post('/:db/_query', async (req, res) => {
  const databaseName = req.params.db
  if (!utils.validDatabaseName(databaseName)) {
    return sendError(res, 400, 'Invalid database name')
  }
  const query = req.body
  if (!query || typeof query !== 'object') {
    return sendError(res, 400, 'Invalid query')
  }
  if (!query.index) {
    return sendError(res, 400, 'Missing Parameter "index"')
  }
  if (!query.index.match(/^i[0-9]+$/)) {
    return sendError(res, 400, 'Invalid Parameter "index"')
  }
  if (!query.startkey && !query.endkey && !query.key) {
    return sendError(res, 400, 'Missing Parameter "startkey/endkey/key"')
  }

  // limit parameter
  const limit = query.limit ? query.limit : 100
  if (limit && (typeof limit !== 'number' || limit < 1)) {
    return sendError(res, 400, 'Invalid limit parameter')
  }

  // offset parameter
  const offset = query.offset ? query.offset : 0
  if (offset && (typeof offset !== 'number' || offset < 0)) {
    return sendError(res, 400, 'Invalid offset parameter')
  }

  try {
    const sql = queryutils.prepareQuerySQL(databaseName, query.index, query.key, query.startkey, query.endkey, query.limit, query.offset)
    debug(sql.sql, sql.values)
    const data = await client.query(sql.sql, sql.values)
    const obj = {
      docs: []
    }
    for (var i in data.rows) {
      const row = data.rows[i]
      const doc = docutils.processResultDoc(row)
      obj.docs.push(doc)
    }
    res.send(obj)
  } catch (e) {
    debug(e)
    sendError(res, 404, 'Could not query database')
  }
})

// GET /db/_all_docs
// get all documents
app.get('/:db/_all_docs', async (req, res) => {
  const databaseName = req.params.db
  const includeDocs = req.query.include_docs === 'true'
  let startkey, endkey, limit, offset

  try {
    startkey = req.query.startkey ? JSON.parse(req.query.startkey) : undefined
    endkey = req.query.endkey ? JSON.parse(req.query.endkey) : undefined
    limit = req.query.limit ? JSON.parse(req.query.limit) : 100
    offset = req.query.offset ? JSON.parse(req.query.offset) : 0
  } catch (e) {
    return sendError(res, 400, 'Invalid startkey/endkey/limit/offset parameters')
  }

  // check limit parameter
  if (limit && (typeof limit !== 'number' || limit < 1)) {
    return sendError(res, 400, 'Invalid limit parameter')
  }

  // offset parameter
  if (offset && (typeof offset !== 'number' || offset < 0)) {
    return sendError(res, 400, 'Invalid offset parameter')
  }

  // const offset = 0
  const sql = queryutils.prepareAllDocsSQL(databaseName, includeDocs, startkey, endkey, limit, offset)

  try {
    debug(sql.sql, sql.values)
    const data = await client.query(sql.sql, sql.values)
    const obj = {
      rows: []
    }
    for (var i in data.rows) {
      const row = data.rows[i]
      const doc = row.json ? row.json : {}
      doc._id = row.id
      doc._rev = '0-1'
      const thisobj = { id: row.id, key: row.id, value: { rev: '0-1' } }
      if (includeDocs) {
        thisobj.doc = docutils.processResultDoc(row)
      }
      obj.rows.push(thisobj)
    }
    res.send(obj)
  } catch (e) {
    sendError(res, 404, 'Could not retrieve documents')
  }
})

// GET /db/doc
// get a doc with a known id
app.get('/:db/:id', async (req, res) => {
  const databaseName = req.params.db
  if (!utils.validDatabaseName(databaseName)) {
    return sendError(res, 400, 'Invalid database name')
  }
  const id = req.params.id
  if (!utils.validID(id)) {
    return sendError(res, 400, 'Invalid id')
  }
  try {
    const sql = docutils.prepareGetSQL(databaseName)
    debug(sql)
    const data = await client.query(sql, [id])
    const doc = docutils.processResultDoc(data.rows[0])
    res.send(doc)
  } catch (e) {
    sendError(res, 404, 'Document not found ' + id)
  }
})

// PUT /db/doc
// add a doc with a known id
app.put('/:db/:id', readOnlyMiddleware, async (req, res) => {
  const databaseName = req.params.db
  if (!utils.validDatabaseName(databaseName)) {
    return sendError(res, 400, 'Invalid database name')
  }
  const id = req.params.id
  if (!utils.validID(id)) {
    return sendError(res, 400, 'Invalid id')
  }
  const doc = req.body
  if (!doc || typeof doc !== 'object') {
    return sendError(res, 400, 'Invalid JSON')
  }
  try {
    await writeDoc(databaseName, id, doc)
    res.status(201).send({ ok: true, id: id, rev: '0-1' })
  } catch (e) {
    debug(e)
    sendError(res, 404, 'Could not write document ' + id)
  }
})

// DELETE /db/doc
// delete a doc with a known id
app.delete('/:db/:id', readOnlyMiddleware, async (req, res) => {
  const databaseName = req.params.db
  if (!utils.validDatabaseName(databaseName)) {
    return sendError(res, 400, 'Invalid database name')
  }
  const id = req.params.id
  if (!utils.validID(id)) {
    return sendError(res, 400, 'Invalid id')
  }
  try {
    const preparedQuery = docutils.prepareDeleteSQL(databaseName, id)
    debug(preparedQuery.sql, preparedQuery.values)
    await client.query(preparedQuery.sql, preparedQuery.values)
    res.send({ ok: true, id: id, rev: '0-1' })
  } catch (e) {
    debug(e)
    sendError(res, 404, 'Could not delete document ' + databaseName + '/' + id)
  }
})

// POST /db
// add a doc without an id
app.post('/:db', readOnlyMiddleware, async (req, res) => {
  const databaseName = req.params.db
  if (!utils.validDatabaseName(databaseName)) {
    return sendError(res, 400, 'Invalid database name')
  }
  const id = kuuid.id()
  const doc = req.body
  try {
    await writeDoc(databaseName, id, doc)
    res.status(201).send({ ok: true, id: id, rev: '0-1' })
  } catch (e) {
    debug(e)
    sendError(res, 400, 'Could not save document')
  }
})

// PUT /db
// create a database
app.put('/:db', readOnlyMiddleware, async (req, res) => {
  const databaseName = req.params.db
  if (!utils.validDatabaseName(databaseName)) {
    return sendError(res, 400, 'Invalid database name')
  }
  debug('Creating database - ' + databaseName)
  try {
    const sql = tableutils.prepareCreateTableTransaction(databaseName)
    for (var i = 0; i < sql.length; i++) {
      debug(sql[i])
      await client.query(sql[i])
    }
    res.status(201).send({ ok: true })
  } catch (e) {
    debug(e)
    sendError(res, 400, 'Could not create database' + databaseName)
  }
})

// DELETE /db
// delete a database (table)
app.delete('/:db', readOnlyMiddleware, async (req, res) => {
  const databaseName = req.params.db
  if (!utils.validDatabaseName(databaseName)) {
    return sendError(res, 400, 'Invalid database name')
  }
  debug('Delete database - ' + databaseName)
  try {
    const sql = tableutils.prepareDropTableSQL(databaseName)
    debug(sql)
    await client.query(sql)
    res.send({ ok: true })
  } catch (e) {
    debug(e)
    sendError(res, 404, 'Could not drop database ' + databaseName)
  }
})

// GET /db
// get info on database (table)
app.get('/:db', async (req, res) => {
  const databaseName = req.params.db
  if (!utils.validDatabaseName(databaseName)) {
    return sendError(res, 400, 'Invalid database name')
  }
  debug('Get database info - ' + databaseName)
  try {
    // size
    let sql = tableutils.prepareTableSizeSQL(databaseName)
    debug(sql)
    const databaseSize = await client.query(sql.sql, sql.values)

    // doc count
    sql = tableutils.prepareTableRowCountSQL(databaseName)
    const databaseCount = await client.query(sql)

    // deleted doc count
    sql = tableutils.prepareTableDeletedRowCountSQL(databaseName)
    const databaseDelCount = await client.query(sql)

    const obj = {
      db_name: databaseName,
      instance_start_time: '0',
      doc_count: databaseCount.rows[0].c,
      doc_del_count: databaseDelCount.rows[0].c,
      sizes: {
        file: databaseSize.rows[0].size,
        active: databaseSize.rows[0].size
      }
    }
    res.send(obj)
  } catch (e) {
    debug('error', e)
    sendError(res, 404, 'Could not get database info for ' + databaseName)
  }
})

// GET /
// return server information
app.get('/', (req, res) => {
  const obj = {
    postDB: 'Welcome',
    pkg: pkg.name,
    node: process.version,
    version: pkg.version
  }
  res.send(obj)
})

// backstop route
app.use(function (req, res) {
  res.status(404).send({ error: 'missing' })
})

// main
const main = async () => {
  try {
    // connect to PostgreSQL
    await client.connect()

    // create _replicator database
    const sql = tableutils.prepareCreateReplicatorTableSQL()
    await client.query(sql)

    // start up the app
    app.listen(defaults.port, () => console.log(`${pkg.name} listening on port ${defaults.port}!`))
  } catch (e) {
    console.error('Cannot connect to PostgreSQL')
  }
}
main()
