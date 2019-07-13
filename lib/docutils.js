const defaults = require('./defaults.js')

// prepare SQL statement
const prepareInsertSQL = (databaseName, id, doc) => {
  const fields = ['id', 'json', 'deleted']
  const replacements = ['$1', '$2', '$3']
  const smallDoc = JSON.parse(JSON.stringify(doc))
  Object.keys(smallDoc).map((key) => {
    if (key.startsWith('_')) {
      delete smallDoc[key]
    }
  })
  const values = [id, smallDoc, 'FALSE']
  for (var i = 1; i <= defaults.indexes; i++) {
    fields.push('i' + i)
    replacements.push('$' + (i + 3))
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
  return { sql: sql, values: values }
}

// delete SQL
const prepareDeleteSQL = (databaseName, id) => {
  let sql = 'UPDATE ' + databaseName + ' SET deleted=TRUE,json=\'{}\''
  for (var i = 0; i < defaults.indexes; i++) {
    sql += ' ,i' + (i + 1) + '=\'\''
  }
  sql += ' WHERE id = $1'
  return { sql: sql, values: [id] }
}

// get SQL
const prepareGetSQL = (databaseName, id) => {
  return 'SELECT * FROM ' + databaseName + ' WHERE id = $1 AND DELETED=false'
}

// purge transaction
const preparePurgeTransaction = (databaseName, keys) => {
  const sql = []
  sql.push({ sql: 'BEGIN', values: [] })
  for (var i = 0; i < keys.length; i++) {
    const s = 'DELETE FROM ' + databaseName + ' WHERE id=$1'
    sql.push({ sql: s, values: [keys[i]] })
  }
  sql.push({ sql: 'COMMIT', values: [] })
  return sql
}

// process result doc
const processResultDoc = (row) => {
  const doc = row.json
  doc._id = row.id
  doc._rev = '0-1'
  for (var i = 1; i <= defaults.indexes; i++) {
    doc['_i' + i] = row['i' + i]
  }
  return doc
}

module.exports = {
  prepareInsertSQL,
  prepareDeleteSQL,
  prepareGetSQL,
  preparePurgeTransaction,
  processResultDoc
}
