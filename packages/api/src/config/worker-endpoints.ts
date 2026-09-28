/** Local defaults for API routing to the single Worker or split role processes. */
export const LOCAL_WORKER_ENDPOINTS = [
  'local-worker=http://127.0.0.1:8091',
  'local-worker-executor=http://127.0.0.1:8092',
  'local-worker-scheduler=http://127.0.0.1:8093',
  'local-worker-analyst=http://127.0.0.1:8094',
  'local-worker-maintenance=http://127.0.0.1:8095',
].join(',')

export function withLocalWorkerEndpoints(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.CAIRN_WORKER_ENDPOINTS?.trim()) return env
  return { ...env, CAIRN_WORKER_ENDPOINTS: LOCAL_WORKER_ENDPOINTS }
}
