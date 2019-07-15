// powers _all_docs
const prepareAllDocsSQL = (databaseName, includeDocs, startkey, endkey, limit, offset) => {
  let fields = 'id'
  const params = []
  if (includeDocs) {
    fields = '*'
  }
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
  return { sql: sql, values: params }
}

// powers _query
const prepareQuerySQL = (databaseName, index, key, startkey, endkey, limit, offset) => {
  let sql = 'SELECT * FROM ' + databaseName + ' WHERE deleted=FALSE'
  const params = []
  if (startkey || endkey) {
    startkey = startkey || ''
    endkey = endkey || '~'
    sql += ' AND ' + index + ' >= $1 AND ' + index + ' <= $2'
    params.push(startkey)
    params.push(endkey)
  } else if (key) {
    sql += ' AND ' + index + ' = $1'
    params.push(key)
  }
  sql += ' ORDER BY ' + index
  if (limit) {
    sql += ' LIMIT ' + limit
  }
  if (offset) {
    sql += ' OFFSET ' + offset
  }
  return { sql: sql, values: params }
}

// powers _changes
const prepareChangesSQL = (databaseName, since, includeDocs, limit, excludeClusterId) => {
  let fields = 'id,seq,deleted,clusterid'
  const values = [since]
  if (includeDocs) {
    fields = '*'
  }
  let sql = 'SELECT ' + fields + ' FROM ' + databaseName + ' WHERE seq > $1'
  if (excludeClusterId) {
    sql += ' AND clusterid != $2'
    values.push(excludeClusterId)
  }
  sql += ' ORDER BY seq'
  if (limit) {
    sql += ' LIMIT ' + limit
  }
  return { sql: sql, values: values }
}
module.exports = {
  prepareAllDocsSQL,
  prepareQuerySQL,
  prepareChangesSQL
}
