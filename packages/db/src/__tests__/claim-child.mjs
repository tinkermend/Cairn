import { createDb, claimRun } from '../../dist/index.js'
process.once('message', async ({ env, worker }) => {
  const db = createDb(env)
  try {
    const grants = []
    for (let i = 0; i < 24; i++) {
      const grant = await claimRun(db, { ...worker, leaseTtlSeconds: 60 })
      if (!grant) break
      grants.push(grant)
    }
    process.send({ grants })
  } catch (error) { process.send({ error: error.message }) }
  finally { await db.close(); process.disconnect() }
})
