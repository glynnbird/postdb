
// find new replication jobs
const prepareFindNewJobsSQL = () => {
  return 'SELECT * FROM _replicator WHERE i1 = \'new\''
}

module.exports = {
  prepareFindNewJobsSQL
}