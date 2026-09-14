import { createDb, type DbHandle } from '../index.js'
// @ts-expect-error ORM operators cannot be imported by business code
import { sql } from '../index.js'
// @ts-expect-error physical schema cannot be imported by business code
import { runs } from '../index.js'
declare const handle: DbHandle
// @ts-expect-error native connection is intentionally inaccessible
handle.db.select()
// @ts-expect-error native pool is intentionally inaccessible
handle.pool.connect()
void createDb
