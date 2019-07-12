// modules and libraries
const express = require('express')
const defaults = require('./lib/defaults.js')
const utils = require('./lib/utils.js')
const pkg = require('./package.json')
const debug = require('debug')(pkg.name)
const app = express()
const basicAuth = require('express-basic-auth')
const kuuid = require('kuuid')
const morgan = require('morgan')

// incoming environment variables
const port = process.env.PORT || defaults.port
const indexes = process.env.INDEXES || defaults.indexes
const readOnlyFlag = process.env.READONLY || defaults.readonly
const readOnlyMode = !!readOnlyFlag
const username = process.env.USERNAME || defaults.username
const password = process.env.PASSWORD || defaults.password

// JSON parsing middleware
const bodyParser = require('body-parser')
app.use(bodyParser.json())

// Logging middleware
const loggingFormat = process.env.LOGGING || defaults.logging
if (loggingFormat !== 'none') {
  app.use(morgan(loggingFormat))
}

// AUTH middleware
if (username && password) {
  console.log('NOTE: authentication mode')
  const obj = {}
  obj[username] = password
  app.use(basicAuth({ users: obj }))
}

// readonly middleware
const readOnlyMiddleware = require('./lib/readonly.js')(readOnlyMode)
if (readOnlyMode) {
  console.log('NOTE: readonly mode')
}

// PostgreSQL Client
const { Client } = require('pg')
const client = new Client()

// send error
const sendError = (res, statusCode, str) => {
  res.status(statusCode).send({ error: str })
}

// prepare SQL statement
const prepareInsertSQL = (databaseName, id, doc) => {
  const fields = ['id', 'json', 'ts', 'deleted']
  const replacements = ['$1', '$2', '$3', '$4']
  const smallDoc = JSON.parse(JSON.stringify(doc))
  Object.keys(smallDoc).map((key) => {
    if (key.startsWith('_')) {
      delete smallDoc[key]
    }
  })
  const values = [id, smallDoc, kuuid.prefix(), 'FALSE']
  for (var i = 1; i <= indexes; i++) {
    fields.push('i' + i)
    replacements.push('$' + (i + 4))
    values.push(doc['_i' + i] ? doc['_i' + i] : '')
  }
  const pairs = []
  let j = 1
  fields.forEach((f) => {
    const pair = f + ' = $' + j
    pairs.push(pair)
    j++
  })
  const sql = 'INSERT INTO ' + databaseName + ' (' + fields.join(',') + ') VALUES (' + replacements.join(',') + ') ON CONFLICT (id) DO UPDATE SET ' + pairs.join(',') + ' WHERE ' + databaseName + '.id = $1'
  console.log({ sql: sql, values: values })
  return { sql: sql, values: values }
}

// delete SQL
const prepareDeleteSQL = (databaseName, id) => {
  const ts = kuuid.prefix()
  let sql = 'UPDATE ' + databaseName + ' SET deleted=TRUE,ts=$1'
  for (var i = 0; i < indexes; i++) {
    sql += ' ,i' + (i + 1) + '=\'\''
  }
  sql += ' WHERE id = $2'
  return { sql: sql, values: [ts, id] }
}

// write a document to the database
const writeDoc = async (databaseName, id, doc) => {
  debug('Add document ' + id + ' to database - ' + databaseName)
  const preparedQuery = prepareInsertSQL(databaseName, id, doc)
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
      preparedQuery = prepareDeleteSQL(databaseName, id)
    } else {
      // update or insert
      id = doc._id || kuuid.id()
      if (!utils.validID(id)) {
        response.push({ ok: false, id: id, error: 'invalid _id' })
        continue
      }
      preparedQuery = prepareInsertSQL(databaseName, id, doc)
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
    const sql = 'SELECT table_name  FROM information_schema.tables WHERE table_schema=\'public\''
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
  let fields = 'id,ts,deleted'
  if (includeDocs) {
    fields = '*'
  }
  let sql = 'SELECT ' + fields + ' FROM ' + databaseName + ' WHERE ts > $1'
  sql += ' ORDER BY ts'
  if (limit) {
    sql += ' LIMIT ' + limit
  }
  console.log(sql)
  try {
    const data = await client.query(sql, [since])
    const obj = {
      last_seq: '',
      results: []
    }
    let lastSeq = since
    for (var i in data.rows) {
      const row = data.rows[i]
      const doc = row.json ? row.json : {}
      doc._id = row.id
      doc._rev = '0-1'

      const thisobj = {
        changes: [{ rev: '0-1' }],
        id: row.id,
        seq: row.ts
      }
      if (row.deleted) {
        thisobj.deleted = true
      }
      if (includeDocs) {
        for (i = 1; i <= indexes; i++) {
          doc['_i' + i] = row['i' + i]
        }
        thisobj.doc = doc
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
// query one of the indexes
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
    let sql = 'SELECT * FROM ' + databaseName + ' WHERE deleted=FALSE'
    const params = []
    if (query.startkey || query.endkey) {
      query.startkey = query.startkey ? query.startkey : ''
      query.endkey = query.endkey ? query.endkey : '~'
      sql += ' AND ' + query.index + ' >= $1 AND ' + query.index + ' <= $2'
      sql += ' ORDER BY ' + query.index
      params.push(query.startkey)
      params.push(query.endkey)
    } else if (query.key) {
      sql += ' AND ' + query.index + ' = $1'
      params.push(query.key)
    }
    if (limit) {
      sql += ' LIMIT ' + limit
    }
    if (offset) {
      sql += ' OFFSET ' + offset
    }
    debug(sql, params)
    const data = await client.query(sql, params)
    const obj = {
      docs: []
    }
    for (var i in data.rows) {
      const row = data.rows[i]
      const doc = row.json ? row.json : {}
      doc._id = row.id
      doc._rev = '0-1'
      for (var j = 1; j <= indexes; j++) {
        doc['_i' + j] = data.rows[i]['i' + j]
      }
      obj.docs.push(doc)
    }
    res.send(obj)
  } catch (e) {
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
  const params = []
  let fields = 'id'
  if (includeDocs) {
    fields = '*'
  }

  // build the query
  let sql = 'SELECT ' + fields + ' FROM ' + databaseName + ' WHERE deleted=FALSE '
  if (startkey || endkey) {
    sql += ' AND '
    startkey = startkey || ''
    endkey = endkey || '~'
    sql += 'id >= $1 AND id <= $2'
    params.push(startkey)
    params.push(endkey)
  }
  if (limit) {
    sql += ' LIMIT ' + limit
  }
  if (offset) {
    sql += ' OFFSET ' + offset
  }

  try {
    debug(sql)
    const data = await client.query(sql, params)
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
        for (var j = 1; j <= indexes; j++) {
          doc['_i' + j] = row['i' + j]
        }
        thisobj.doc = doc
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
    const sql = 'SELECT * FROM ' + databaseName + ' WHERE id = $1 AND DELETED=false'
    debug(sql)
    const data = await client.query(sql, [id])
    const doc = data.rows[0].json
    doc._id = id
    doc._rev = '0-1'
    for (var i = 1; i <= indexes; i++) {
      doc['_i' + i] = data.rows[0]['i' + i]
    }
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
    const preparedQuery = prepareDeleteSQL(databaseName, id)
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
  const fields = ['id VARCHAR(255) PRIMARY KEY', 'json json NOT NULL', 'ts VARCHAR(8) NOT NULL', 'deleted BOOLEAN NOT NULL']
  for (var i = 1; i <= indexes; i++) {
    fields.push('i' + i + ' VARCHAR(100)')
  }
  try {
    let sql = 'CREATE TABLE IF NOT EXISTS ' + databaseName + ' (' + fields.join(',') + ')'
    debug(sql)
    await client.query('BEGIN')
    await client.query(sql)
    for (i = 1; i <= indexes; i++) {
      const field = 'i' + i
      const indexName = databaseName + '_' + field
      sql = 'CREATE INDEX ' + indexName + ' ON ' + databaseName + '(' + field + ')'
      debug(sql)
      await client.query(sql)
    }
    const indexName = databaseName + '__ts'
    sql = 'CREATE INDEX ' + indexName + ' ON ' + databaseName + '(ts)'
    debug(sql)
    await client.query(sql)
    await client.query('COMMIT')
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
    const sql = 'DROP TABLE ' + databaseName + ' CASCADE'
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
    let sql = 'SELECT relname as database, pg_total_relation_size(C.oid) as size FROM pg_class C LEFT JOIN pg_namespace N ON (N.oid = C.relnamespace) WHERE nspname NOT IN (\'pg_catalog\', \'information_schema\') AND C.relkind <> \'i\' AND nspname !~ \'^pg_toast\' AND relname = $1'
    debug(sql)
    const databaseSize = await client.query(sql, [databaseName])
    sql = 'SELECT COUNT(*) as c from ' + databaseName + ' WHERE deleted=FALSE'
    const databaseCount = await client.query(sql)
    sql = 'SELECT COUNT(*) as c from ' + databaseName + ' WHERE deleted=TRUE'
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
    await client.connect()
    app.listen(port, () => console.log(`${pkg.name} listening on port ${port}!`))
  } catch (e) {
    console.error('Cannot connect to PostgreSQL')
  }
}
main()
