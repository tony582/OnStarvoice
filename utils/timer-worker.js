// 可靠计时器线程(供 capture-sync.js 的 waitMs/sleep 使用)。
//
// 背景:Chrome 会对「隐藏超过约 5 分钟的标签页」做强力计时器节流——页面主线程的
// setTimeout 被对齐到约 1 分钟一次(慢 200 倍)。无人值守批量采集的编排代码跑在
// 隐藏的 runner 标签页里,全部等待/轮询靠 setTimeout,一旦被节流,整个流程就以
// 分钟级速度爬行,表现为「第一个词正常、第二个词起假死」。
// Worker 线程没有页面可见性概念,其计时器不受该节流影响,故用它做时钟源。
self.onmessage = (event) => {
  const id = event?.data?.id;
  const ms = Math.max(0, Number(event?.data?.ms) || 0);
  setTimeout(() => {
    self.postMessage({ id });
  }, ms);
};
