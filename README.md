
# PostDB

*PostDB* is proof-of-concept database that exposes a CouchDB-like API but which is backed by a PostgreSQL database. It supports:

- Create/Delete database API
- Insert/Update/Delete document API, without requiring revision tokens.
- Fetch all documentes or a range using the primary index.
- Fetch documents by key or range of keys using one of three (by default) secondary indexes.

It does not implement CouchDB's MVCC, Design Documents, attachments, replication, changes feed, MapReduce, "Mango" search or any other CouchDB feature.

It does however provide a "consistent" data store where the documents and secondary indexes are in lock-step. Documents are limited to 100KB in size.

## Running 

Install the dependencies and run on your machine:

```sh
npm install
npm run start
```

The application will connect to local PostgreSQL instance and start serving out its API on port 5984. by default.

## API Reference

### Create Database - PUT /db

```sh
$ curl -X PUT http://localhost:5984/mydb
{ok:true}
```

### Get Database Info  - GET /db

```sh
$ curl -X GET http://localhost:5984/mydb
{"db_name":"mydb","instance_start_time":"0","doc_count":"0","sizes":{"file":"40960","active":"0"}
```

### Add a document (known ID) - PUT /db/id

```sh
$ curl -X PUT \
       -H 'Content-type: application/json' \
       -d '{"x": 1, "y": false, "z": "aardvark"}' \
       http://localhost:5984/mydb/a
{"ok":true,"id":"a","rev":"0-1"}
```

### Add a document (generated ID) - POST /db

```sh
$ curl -X POST \
       -H 'Content-type: application/json' \
       -d '{"x": 2, "y": true, "z": "bear"}' \
       http://localhost:5984/mydb
{"ok":true,"id":"001hla5z2pEedb3wB5rI2Rkd0k2pzUQg","rev":"0-1"}
```

### Get a document by id - GET /db/id

```sh
$ curl -X GET http://localhost:5984/mydb/a
{"x":1,"y":false,"z":"aardvark","_id":"a","_rev":"0-1","_i1":"","_i2":"","_i3":""}
```

### Get all documents - GET /db/_all_docs

```sh
$ curl -X GET http://localhost:5984/mydb/_all_docs
{"offset":0,"rows":[{"id":"a","key":"a","value":{"rev":"0-1"}},{"id":"001hla5z2pEedb3wB5rI2Rkd0k2pzUQg","key":"001hla5z2pEedb3wB5rI2Rkd0k2pzUQg","value":{"rev":"0-1"}},{"id":"b","key":"b","value":{"rev":"0-1"}},{"id":"c","key":"c","value":{"rev":"0-1"}},{"id":"d","key":"d","value":{"rev":"0-1"}},{"id":"e","key":"e","value":{"rev":"0-1"}},{"id":"f","key":"f","value":{"rev":"0-1"}}],"total_rows":0}
```

Add `include_docs=true` to include document bodies:

```sh
$ curl -X GET http://localhost:5984/mydb/_all_docs?include_docs=true
{"offset":0,"rows":[{"id":"a","key":"a","value":{"rev":"0-1"},"doc":{"x":1,"y":false,"z":"aardvark","_id":"a","_rev":"0-1","_i1":"","_i2":"","_i3":""}},{"id":"001hla5z2pEedb3wB5rI2Rkd0k2pzUQg","key":"001hla5z2pEedb3wB5rI2Rkd0k2pzUQg","value":{"rev":"0-1"},"doc":{"x":2,"y":true,"z":"bear","_id":"001hla5z2pEedb3wB5rI2Rkd0k2pzUQg","_rev":"0-1","_i1":"","_i2":"","_i3":""}},{"id":"b","key":"b","value":{"rev":"0-1"},"doc":{"x":1,"y":false,"z":"bat","_id":"b","_rev":"0-1","_i1":"","_i2":"","_i3":""}},{"id":"c","key":"c","value":{"rev":"0-1"},"doc":{"x":1,"y":false,"z":"cat","_id":"c","_rev":"0-1","_i1":"","_i2":"","_i3":""}},{"id":"d","key":"d","value":{"rev":"0-1"},"doc":{"x":1,"y":false,"z":"dog","_id":"d","_rev":"0-1","_i1":"","_i2":"","_i3":""}},{"id":"e","key":"e","value":{"rev":"0-1"},"doc":{"x":1,"y":false,"z":"eagle","_id":"e","_rev":"0-1","_i1":"","_i2":"","_i3":""}},{"id":"f","key":"f","value":{"rev":"0-1"},"doc":{"x":1,"y":false,"z":"fox","_id":"f","_rev":"0-1","_i1":"","_i2":"","_i3":""}}],"total_rows":0}
```

Add a `limit` to reduce number of rows returned:

```sh
$ curl -X GET http://localhost:5984/mydb/_all_docs?limit=2
{"offset":0,"rows":[{"id":"a","key":"a","value":{"rev":"0-1"}},{"id":"001hla5z2pEedb3wB5rI2Rkd0k2pzUQg","key":"001hla5z2pEedb3wB5rI2Rkd0k2pzUQg","value":{"rev":"0-1"}}],"total_rows":0}
```

Use `startkey`/`endkey` to fetch a range of document ids:

```sh
$ curl -X GET 'http://localhost:5984/mydb/_all_docs?startkey="b"&endkey="d"'
{"offset":0,"rows":[{"id":"b","key":"b","value":{"rev":"0-1"}},{"id":"c","key":"c","value":{"rev":"0-1"}},{"id":"d","key":"d","value":{"rev":"0-1"}}],"total_rows":0}
```

### Delete a document - DELETE /db/id

```sh
$ curl -X DELETE http://localhost:5984/mydb/001hla5z2pEedb3wB5rI2Rkd0k2pzUQg
{"ok":true,"id":"001hla5z2pEedb3wB5rI2Rkd0k2pzUQg","rev":"0-1"}
```

### Delete a database - DELETE /db

```sh
$ curl -X DELETE http://localhost:5984/mydb
{"ok":true}
```

## Indexing

As *PostDB* has no MapReduce, or Mango search but it does allow a number of specific fields to be indexed. By default, there are three indexed fields: `_i1`, `_i2` & `_i3`. For example your document could look like this:

```js
{
  "_id": "abc123",
  "_i1": "1561972800000",
  "_i2": "smith",
  "_i3": "person:uk:2019-07-01",
  "type": "person",
  "name": "Bob Smith",
  "dob": "1965-04-21",
  "country": "uk",
  "lastLogin": "2019-07-01 10:20:00"
}
```

In this case `_i1` is used to extract users by a timestamp, perhaps last login. The `_i2` index is used to extract users by surname, all lowercase. The third compounds several fields: document type, country and last login date.

If documents don't need additional data indexed, then the fields can be omitted or left as empty strings. All the indexed fields must be strings.

The indexed data can be accessed using the `POST /db/_query` endpoint, which differs from CouchDB's. It expects a JSON object that defines the query like so:

```js
{ 
  "index": "i1",
  "startkey: "c",
  "endkey": "m"
}
``` 

e.g

```sh
```sh
$ curl -X POST \
       -H 'Content-type: application/json' \
       -d '{"index": "i1", "startkey": "e", "endkey": "m"}' \
       http://localhost:5984/mydb/_query
{"docs":[...]}
```

Parameters:

- `index` - the name of index to query (mandatory).
- `startkey`/`endkey` - one or both supplied, for range queries.
- `key` - the key in the index to search for, for selection queries.
- `limit` - the number of documents to return

## Configuring

The application is configured using environment variables

- `PORT` - the port that the database's web server will listen on. Default 5984.
- `INDEXES` - the number of secondary indexes created. Default 3.

## To do

- READONLY mode - to allow read-only replicas
- PostgreSQL connection parameter
- offset (to go with limit)

