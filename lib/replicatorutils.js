
// find new replication jobs
const prepareFindNewJobsSQL = () => {
  return 'SELECT * FROM _replicator WHERE i1 = \'new\''
}

// find new or running jobs - for startup use
const prepareFindNewOrRunningJobsSQL = () => {
  return 'SELECT * FROM _replicator WHERE i1 = \'new\' OR i1 = \'running\''
}

module.exports = {
  prepareFindNewJobsSQL,
  prepareFindNewOrRunningJobsSQL
}
