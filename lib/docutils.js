const defaults = require('./defaults.js')

// auto incrementing sequence for insert, update, delete
const prepareMaxSeqSQL = (databaseName) => {
  return '(SELECT COALESCE(MAX(seq),0)+1 FROM ' + databaseName + ')'
}

// prepare SQL statement
const prepareInsertSQL = (databaseName, id, doc, clusterid) => {
  const fields = ['id', 'json', 'deleted', 'clusterid']
  clusterid = clusterid || ''
  const maxSeq = prepareMaxSeqSQL(databaseName)
  const replacements = ['$1', '$2', '$3', '$4']
  const smallDoc = JSON.parse(JSON.stringify(doc))
  Object.keys(smallDoc).map((key) => {
    if (key.startsWith('_')) {
      delete smallDoc[key]
    }
  })
  const values = [id, smallDoc, 'FALSE', clusterid]
  for (var i = 1; i <= defaults.indexes; i++) {
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
  const sql = 'INSERT INTO ' + databaseName + ' (' + fields.join(',') + ',seq) VALUES (' + replacements.join(',') + ',' + maxSeq + ') ON CONFLICT (id) DO UPDATE SET ' + pairs.join(',') + ',seq=' + maxSeq + ' WHERE ' + databaseName + '.id = $1'
  return { sql: sql, values: values }
}

// delete SQL
const prepareDeleteSQL = (databaseName, id, clusterid) => {
  const maxSeq = prepareMaxSeqSQL(databaseName)
  clusterid = clusterid || ''
  const values = [id, clusterid]
  let sql = 'UPDATE ' + databaseName + ' SET deleted=TRUE,json=\'{}\',seq=' + maxSeq
  for (var i = 0; i < defaults.indexes; i++) {
    sql += ' ,i' + (i + 1) + '=\'\''
  }
  sql += ' ,clusterid = $2'
  sql += ' WHERE id = $1'
  return { sql: sql, values: values }
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
