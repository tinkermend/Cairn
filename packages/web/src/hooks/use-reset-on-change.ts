import { useState } from 'react'

const UNSET: unique symbol = Symbol('unset')

/**
 * 首次渲染及 key 每次变化时，在渲染期同步调整本组件的 state —— React 推荐的「随 props 调整 state」写法
 * （https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes）。
 * 与「deps 为 [key] 的 effect 里 setState」时机一致（含首次挂载），但少一轮提交，也不会先用旧 state 渲染一帧。
 *
 * reset 只能设置调用方组件自己的 state，不得有副作用（请求、订阅、改外部对象）。
 * key 用 Object.is 比较：对象 key 需保持引用稳定（查询数据、useMemo 结果），不要每次渲染新建。
 */
export function useResetOnChange<T>(key: T, reset: (key: T) => void): void {
  const [previous, setPrevious] = useState<T | typeof UNSET>(UNSET)
  if (previous === UNSET || !Object.is(previous, key)) {
    setPrevious(key)
    reset(key)
  }
}
