// Executed inside the Mongo container; secrets never appear in process arguments.
const admin = db.getSiblingDB('admin');
if (!admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD)) quit(1);
try { rs.status(); } catch (error) {
  if (error.code === 94 || error.codeName === 'NotYetInitialized') {
    rs.initiate({ _id: 'pagesai', members: [{ _id: 0, host: 'mongo:27017' }] });
    quit(1);
  }
  throw error;
}
quit(admin.hello().isWritablePrimary ? 0 : 1);
