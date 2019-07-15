const defaults = require('./defaults.js')

// create table
const prepareCreateTableSQL = (databaseName) => {
  const fields = ['id VARCHAR(255) PRIMARY KEY', 'json json NOT NULL', 'seq INTEGER', 'deleted BOOLEAN NOT NULL']
  for (var i = 1; i <= defaults.indexes; i++) {
    fields.push('i' + i + ' VARCHAR(100)')
  }
  return 'CREATE TABLE IF NOT EXISTS ' + databaseName + ' (' + fields.join(',') + ')'
}

// create index
const prepareCreateIndexSQL = (databaseName, i) => {
  const field = 'i' + i
  const indexName = databaseName + '_' + field
  return 'CREATE INDEX ' + indexName + ' ON ' + databaseName + '(' + field + ')'
}

// create ts index
const prepareCreateSeqIndexSQL = (databaseName) => {
  const indexName = databaseName + '__seq'
  return 'CREATE INDEX ' + indexName + ' ON ' + databaseName + '(seq)'
}

// create table transaction
const prepareCreateTableTransaction = (databaseName) => {
  const sql = []
  sql.push('BEGIN')
  sql.push(prepareCreateTableSQL(databaseName))
  for (var i = 1; i <= defaults.indexes; i++) {
    sql.push(prepareCreateIndexSQL(databaseName, i))
  }
  sql.push(prepareCreateSeqIndexSQL(databaseName))
  sql.push('COMMIT')
  return sql
}

// drop table
const prepareDropTableSQL = (databaseName) => {
  return 'DROP TABLE ' + databaseName + ' CASCADE'
}

// table list
const prepareTableListSQL = () => {
  return 'SELECT table_name  FROM information_schema.tables WHERE table_schema=\'public\''
}

// table size
const prepareTableSizeSQL = (databaseName) => {
  const sql = 'SELECT relname as database, pg_total_relation_size(C.oid) as size FROM pg_class C LEFT JOIN pg_namespace N ON (N.oid = C.relnamespace) WHERE nspname NOT IN (\'pg_catalog\', \'information_schema\') AND C.relkind <> \'i\' AND nspname !~ \'^pg_toast\' AND relname = $1'
  const values = [databaseName]
  return { sql: sql, values: values }
}

// doc count
const prepareTableRowCountSQL = (databaseName) => {
  return 'SELECT COUNT(*) as c from ' + databaseName + ' WHERE deleted=FALSE'
}

// deleted doc count
const prepareTableDeletedRowCountSQL = (databaseName) => {
  return 'SELECT COUNT(*) as c from ' + databaseName + ' WHERE deleted=TRUE'
}

module.exports = {
  prepareCreateTableSQL,
  prepareCreateIndexSQL,
  prepareCreateSeqIndexSQL,
  prepareCreateTableTransaction,
  prepareDropTableSQL,
  prepareTableListSQL,
  prepareTableSizeSQL,
  prepareTableRowCountSQL,
  prepareTableDeletedRowCountSQL
}
