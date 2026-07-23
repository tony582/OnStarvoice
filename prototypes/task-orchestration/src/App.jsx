import { useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  GripVertical,
  Info,
  Laptop,
  Lock,
  LogOut,
  Monitor,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Sun,
  Users,
  Wifi,
  X,
} from 'lucide-react'

const workPackages = [
  {
    id: 'A',
    label: '关键词 01–05',
    progress: 3,
    tone: 'blue',
    state: '进行中',
    assignedTo: 'Tony 的 MAC',
    keywords: ['别克', '雪佛兰', '凯迪拉克', '新能源汽车', '特斯拉'],
  },
  {
    id: 'B',
    label: '关键词 06–10',
    progress: 4,
    tone: 'green',
    state: '进行中',
    assignedTo: '数据采集机-02',
    keywords: ['宝马', '奔驰', '奥迪', '大众', '沃尔沃'],
  },
  {
    id: 'C',
    label: '关键词 11–15',
    progress: 3,
    tone: 'orange',
    state: '进行中',
    assignedTo: 'WinPool-01',
    keywords: ['小鹏汽车', '比亚迪', '极氪', '问界', '腾势'],
  },
  {
    id: 'D',
    label: '关键词 16–20',
    progress: 2,
    tone: 'red',
    state: '安全受限',
    assignedTo: '76fb804d',
    keywords: ['关键词 16', '关键词 17', '关键词 18', '关键词 19', '关键词 20'],
  },
]

const agents = [
  {
    id: 'tony',
    name: 'Tony 的 MAC',
    environment: 'macOS · ce4fad47 › Edge › 小红书',
    icon: Laptop,
    progress: 3,
    total: 5,
    queue: 1,
    workPackage: 'A',
    status: '健康',
    tone: 'healthy',
  },
  {
    id: 'collector',
    name: '数据采集机-02',
    environment: 'Windows · 0e21b7f1 › Edge › 小红书',
    icon: Monitor,
    progress: 4,
    total: 5,
    queue: 0,
    workPackage: 'B',
    status: '健康',
    tone: 'healthy',
  },
  {
    id: 'winpool',
    name: 'WinPool-01',
    environment: 'Windows · 3f7c9a2b › Edge › 小红书',
    icon: Monitor,
    progress: 3,
    total: 5,
    queue: 1,
    workPackage: 'C',
    status: '健康',
    tone: 'healthy',
  },
  {
    id: 'blocked',
    name: 'macOS · 76fb804d',
    environment: 'macOS · 76fb804d › Edge › 小红书',
    icon: Laptop,
    progress: 2,
    total: 5,
    queue: 0,
    workPackage: 'D',
    status: '受限',
    tone: 'blocked',
  },
]

const recommendedAssignments = [
  { id: 'tony', keyword: '关键词 18', reason: '队列最短', estimate: '预计立即开始' },
  { id: 'collector', keyword: '关键词 19', reason: '账号健康', estimate: '预计 2 分钟后' },
  { id: 'winpool', keyword: '关键词 20', reason: '预计最快', estimate: '预计 4 分钟后' },
]

const modeCopy = {
  manual: '完全由人工选择工作项与目标 Agent，系统只做资格校验。',
  rules: '先校验平台、登录态和冷却状态，再按当前负载均分。',
  hybrid: '硬规则决定谁能执行，AI 在合格 Agent 中优化速度、负载与账号风险。',
}

function Progress({ value, max, tone = 'blue', label }) {
  const percent = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0
  return (
    <div className="progress-wrap" aria-label={label || `进度 ${value}/${max}`}>
      <div className="progress-track">
        <span className={`progress-fill progress-${tone}`} style={{ width: `${percent}%` }} />
      </div>
    </div>
  )
}

function TopBar() {
  return (
    <header className="topbar">
      <div className="brand-group">
        <img className="brand-icon" src="/assets/logo-starvoice.svg" alt="StarVoice" />
        <strong>星语 StarVoice</strong>
        <span className="topbar-divider" />
        <span className="product-name">监测与采集</span>
        <span className="beta-badge">BETA</span>
      </div>
      <div className="topbar-actions">
        <button className="workspace-button" type="button">
          吉事桔香茶 <ChevronDown size={15} />
        </button>
        <button className="admin-button" type="button">
          <span className="admin-avatar">P</span>
          <span>Platform Admin</span>
          <small>平台管理员</small>
        </button>
        <button className="icon-button" type="button" aria-label="主题"><Sun size={18} /></button>
        <button className="icon-button" type="button" aria-label="退出"><LogOut size={18} /></button>
      </div>
    </header>
  )
}

function TaskHeader({ paused, onTogglePause, onSettings }) {
  return (
    <section className="task-header">
      <div>
        <div className="task-title-row">
          <button className="back-button" type="button" aria-label="返回任务调度台"><ArrowLeft size={20} /></button>
          <h1>新能源汽车关键词采集</h1>
          <span className={`task-state ${paused ? 'task-paused' : ''}`}>
            {paused ? <Pause size={13} /> : <ShieldCheck size={13} />}
            {paused ? '已暂停' : '执行中'}
          </span>
          <span className="prototype-badge">交互原型</span>
        </div>
        <div className="task-progress-row">
          <span>整体进度&nbsp; 12 / 20</span>
          <Progress value={12} max={20} label="任务整体进度 12/20" />
          <strong>60%</strong>
          <span>开始时间&nbsp; 2026-07-23 11:20</span>
        </div>
      </div>
      <div className="task-actions">
        <button className="secondary-button" type="button" onClick={onTogglePause}>
          {paused ? <Play size={17} /> : <Pause size={17} />}
          {paused ? '继续任务' : '暂停任务'}
        </button>
        <button className="secondary-button" type="button" onClick={onSettings}>
          <Settings2 size={17} /> 编排设置
        </button>
      </div>
    </section>
  )
}

function PolicyBar({ mode, setMode, settingsOpen }) {
  return (
    <section className={`policy-bar ${settingsOpen ? 'policy-expanded' : ''}`}>
      <div className="policy-title"><span>编排策略</span><CircleHelp size={15} /></div>
      <div className="segmented-control" aria-label="编排策略">
        <button type="button" className={mode === 'manual' ? 'active' : ''} onClick={() => setMode('manual')}>手动</button>
        <button type="button" className={mode === 'rules' ? 'active' : ''} onClick={() => setMode('rules')}>规则</button>
        <button type="button" className={mode === 'hybrid' ? 'active' : ''} onClick={() => setMode('hybrid')}>
          <Sparkles size={15} /> 规则 + AI
        </button>
      </div>
      <span className="policy-divider" />
      <div className="policy-copy">
        <strong>策略说明</strong>
        <span>{modeCopy[mode]}</span>
      </div>
      {settingsOpen && (
        <div className="policy-details">
          <span><Check size={14} /> 仅使用小红书已登录 Agent</span>
          <span><Check size={14} /> 每个 Agent 并发 1</span>
          <span><Check size={14} /> 安全限制默认人工确认</span>
        </div>
      )}
    </section>
  )
}

function BusinessTaskPanel() {
  return (
    <section className="flow-panel business-panel">
      <header className="panel-header">
        <span className="step-number">1</span>
        <h2>业务任务</h2>
      </header>
      <div className="business-body">
        <div className="platform-mark">小红书</div>
        <h3>20 个关键词</h3>
        <span className="section-label">完成标准</span>
        <ul className="criteria-list">
          <li><CheckCircle2 size={16} /> 每个关键词采集 ≥ 50 个结果</li>
          <li><CheckCircle2 size={16} /> 去重率 ≥ 95%</li>
          <li><CheckCircle2 size={16} /> 含标题、笔记链接、发布时间等</li>
          <li className="pending"><Clock3 size={16} /> 数据通过合规校验</li>
        </ul>
        <dl className="task-meta">
          <div><dt>任务编号</dt><dd>T-20260723-001</dd></div>
          <div><dt>创建人</dt><dd>Platform Admin</dd></div>
          <div><dt>创建时间</dt><dd>2026-07-23 11:20</dd></div>
        </dl>
      </div>
    </section>
  )
}

function PackageCard({ item, expanded, onToggle, handoffConfirmed }) {
  const isBlocked = item.id === 'D'
  return (
    <article className={`package-card package-${item.tone} ${expanded ? 'expanded' : ''}`}>
      <button className="package-summary" type="button" onClick={onToggle} aria-expanded={expanded}>
        <span className={`package-letter letter-${item.tone}`}>{item.id}</span>
        <span className="package-name">
          <strong>{item.label}</strong>
          <small>5 个关键词 · {item.assignedTo}</small>
        </span>
        <span className="package-status">
          <strong>{item.progress} / 5</strong>
          <small className={isBlocked ? 'danger-text' : 'success-text'}>
            {isBlocked && handoffConfirmed ? '已生成接力' : item.state}
          </small>
        </span>
        {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {expanded && (
        <div className="package-details">
          {item.keywords.map((keyword, index) => {
            const completed = index < item.progress
            const waitingHandoff = isBlocked && !completed
            return (
              <div className="keyword-row" key={keyword}>
                <GripVertical size={14} />
                <span>{keyword}</span>
                {completed ? (
                  <span className="keyword-state completed"><Check size={12} /> 已完成</span>
                ) : waitingHandoff ? (
                  <span className={`keyword-state ${handoffConfirmed ? 'transferring' : 'handoff'}`}>
                    {handoffConfirmed ? '接力中' : '待接力'}
                  </span>
                ) : (
                  <span className="keyword-state waiting">待执行</span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </article>
  )
}

function WorkItemsPanel({ expandedPackage, setExpandedPackage, handoffConfirmed, onOpenHandoff }) {
  return (
    <section className="flow-panel work-panel">
      <header className="panel-header">
        <span className="step-number">2</span>
        <h2>工作项</h2>
      </header>
      <div className="package-list">
        {workPackages.map(item => (
          <PackageCard
            key={item.id}
            item={item}
            expanded={expandedPackage === item.id}
            handoffConfirmed={handoffConfirmed}
            onToggle={() => setExpandedPackage(expandedPackage === item.id ? '' : item.id)}
          />
        ))}
      </div>
      <button className={`unassigned-tray ${handoffConfirmed ? 'tray-confirmed' : ''}`} type="button" onClick={onOpenHandoff}>
        <div>
          <strong>{handoffConfirmed ? '接力执行中 3' : '待重新分配 3'}</strong>
          <span>{handoffConfirmed ? '已生成新的执行尝试' : '选择后生成接力方案'}</span>
        </div>
        <div className="tray-keywords">
          {['关键词 18', '关键词 19', '关键词 20'].map(keyword => <span key={keyword}>{keyword}</span>)}
        </div>
      </button>
    </section>
  )
}

function AgentCard({ agent, handoffConfirmed }) {
  const DeviceIcon = agent.icon
  const isBlocked = agent.tone === 'blocked'
  const bonus = handoffConfirmed && !isBlocked ? 1 : 0
  const displayProgress = agent.progress
  const displayTotal = agent.total + bonus
  return (
    <article className={`agent-card ${isBlocked ? 'agent-blocked' : ''}`}>
      <div className={`device-icon ${isBlocked ? 'device-blocked' : ''}`}><DeviceIcon size={26} /></div>
      <div className="agent-main">
        <div className="agent-title">
          <strong>{agent.name}</strong>
          <span className={isBlocked ? 'cooling-dot' : 'online-dot'}>
            {isBlocked ? <ShieldAlert size={13} /> : <Wifi size={13} />}
            {isBlocked ? '冷却中' : '在线'}
          </span>
        </div>
        <div className="agent-environment">{agent.environment}</div>
        <div className="agent-stats">
          <span className="agent-work-badge">工作项 {agent.workPackage}</span>
          <span>并发能力&nbsp; 1</span>
          <span>队列&nbsp; {agent.queue + bonus}</span>
          <span>{isBlocked ? '完成' : '进行中'}&nbsp; {displayProgress} / {displayTotal}</span>
        </div>
        <Progress value={displayProgress} max={displayTotal} tone={isBlocked ? 'orange' : 'blue'} label={`${agent.name} 进度`} />
      </div>
      <span className={`agent-health ${isBlocked ? 'blocked-health' : ''}`}>
        {isBlocked ? <AlertTriangle size={14} /> : <ShieldCheck size={14} />}
        {agent.status}
      </span>
      {isBlocked && <div className="blocked-reason">小红书安全受限 · 已暂停领取新工作项</div>}
    </article>
  )
}

function AgentTeamPanel({ handoffConfirmed, onOpenHandoff }) {
  return (
    <section className="flow-panel agent-panel">
      <header className="panel-header panel-header-action">
        <div><span className="step-number">3</span><h2>Agent 小队</h2></div>
        <button type="button" onClick={onOpenHandoff}>查看接力方案 <ArrowRight size={14} /></button>
      </header>
      <div className="agent-list">
        {agents.map(agent => <AgentCard key={agent.id} agent={agent} handoffConfirmed={handoffConfirmed} />)}
      </div>
      <div className="event-note">
        <Info size={16} />
        <span>11:42 检测到平台安全限制；网络或页面异常不会被自动归类为安全受限。</span>
      </div>
    </section>
  )
}

function CandidateRow({ assignment, selected, onToggle }) {
  const agent = agents.find(item => item.id === assignment.id)
  const DeviceIcon = agent.icon
  return (
    <label className={`candidate-row ${selected ? 'selected' : ''}`}>
      <input type="checkbox" checked={selected} onChange={onToggle} />
      <span className="candidate-check">{selected && <Check size={12} />}</span>
      <span className="candidate-rank"><DeviceIcon size={18} /></span>
      <span className="candidate-copy">
        <strong>{agent.name}</strong>
        <small>{assignment.keyword} · {assignment.estimate}</small>
      </span>
      <span className="reason-badge">{assignment.reason}</span>
    </label>
  )
}

function HandoffPanel({
  open,
  onClose,
  transferMode,
  setTransferMode,
  selectedCandidates,
  toggleCandidate,
  onConfirm,
  onManual,
  handoffConfirmed,
}) {
  if (!open) return null
  return (
    <aside className="handoff-panel" aria-label="接力方案详情">
      <header className="handoff-header">
        <div>
          <h2>接力方案详情</h2>
          <span>方案 #1 · 尚未下发</span>
        </div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭接力方案"><X size={18} /></button>
      </header>

      {handoffConfirmed && (
        <div className="confirmed-banner"><CheckCircle2 size={17} /> 接力方案已确认，正在创建新的执行尝试。</div>
      )}

      <section className="handoff-section">
        <h3>受影响关键词（3）</h3>
        <div className="danger-chips">
          {['关键词 18', '关键词 19', '关键词 20'].map(keyword => <span key={keyword}>{keyword}</span>)}
        </div>
      </section>

      <section className="handoff-section">
        <h3>已保留完成结果（2）</h3>
        <div className="preserved-result"><CheckCircle2 size={15} /><span>关键词 16</span><small>共 53 条结果</small></div>
        <div className="preserved-result"><CheckCircle2 size={15} /><span>关键词 17</span><small>共 61 条结果</small></div>
        <p className="section-help">已完整保存，不会重复采集。</p>
      </section>

      <section className="handoff-section">
        <div className="section-title-row">
          <h3>接力分配预览</h3>
          <span>可多选</span>
        </div>
        <div className="candidate-list">
          {recommendedAssignments.map(assignment => (
            <CandidateRow
              key={assignment.id}
              assignment={assignment}
              selected={selectedCandidates.includes(assignment.id)}
              onToggle={() => toggleCandidate(assignment.id)}
            />
          ))}
        </div>
      </section>

      <section className="handoff-section">
        <h3>迁移模式 <CircleHelp size={14} /></h3>
        <label className={`radio-card ${transferMode === 'unstarted' ? 'selected' : ''}`}>
          <input type="radio" name="transfer-mode" value="unstarted" checked={transferMode === 'unstarted'} onChange={() => setTransferMode('unstarted')} />
          <span className="radio-dot" />
          <span><strong>接管未开始项（推荐）</strong><small>新 Agent 从关键词搜索页开始，已完成结果保持不变。</small></span>
        </label>
        <label className={`radio-card ${transferMode === 'checkpoint' ? 'selected' : ''}`}>
          <input type="radio" name="transfer-mode" value="checkpoint" checked={transferMode === 'checkpoint'} onChange={() => setTransferMode('checkpoint')} />
          <span className="radio-dot" />
          <span><strong>从检查点补采当前项</strong><small>重新搜索并去重补采，不迁移原浏览器页面会话。</small></span>
        </label>
      </section>

      <section className="handoff-section manual-section">
        <label htmlFor="manual-agent">手动指定主接力 Agent（可选）</label>
        <select id="manual-agent" defaultValue="">
          <option value="">按推荐方案分配</option>
          <option value="tony">Tony 的 MAC</option>
          <option value="collector">数据采集机-02</option>
          <option value="winpool">WinPool-01</option>
        </select>
        <label className="lock-option"><input type="checkbox" /><span><Lock size={14} /> 锁定本次分配，不参与后续自动重排</span></label>
      </section>

      <div className="prototype-note">
        <Info size={15} />
        <span>交互原型：当前生产调度服务尚未接入跨 Agent 工作项租约与接力。</span>
      </div>

      <footer className="handoff-actions">
        <button className="secondary-button" type="button" onClick={onManual}>手动修改</button>
        <button className="primary-button" type="button" onClick={onConfirm} disabled={selectedCandidates.length === 0 || handoffConfirmed}>
          {handoffConfirmed ? <><Check size={16} /> 已确认</> : '确认接力方案'}
        </button>
      </footer>
    </aside>
  )
}

export function App() {
  const [mode, setMode] = useState('hybrid')
  const [paused, setPaused] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [expandedPackage, setExpandedPackage] = useState('D')
  const [handoffOpen, setHandoffOpen] = useState(true)
  const [handoffConfirmed, setHandoffConfirmed] = useState(false)
  const [transferMode, setTransferMode] = useState('unstarted')
  const [selectedCandidates, setSelectedCandidates] = useState(['tony', 'collector', 'winpool'])
  const [notice, setNotice] = useState('')

  const canvasClassName = useMemo(
    () => `orchestration-grid ${handoffOpen ? 'with-handoff' : 'without-handoff'}`,
    [handoffOpen],
  )

  const toggleCandidate = id => {
    if (handoffConfirmed) return
    setSelectedCandidates(current => current.includes(id) ? current.filter(item => item !== id) : [...current, id])
  }

  const confirmHandoff = () => {
    if (selectedCandidates.length === 0 || handoffConfirmed) return
    setHandoffConfirmed(true)
    setExpandedPackage('D')
    setNotice('接力方案已确认。演示状态已更新，但不会向真实设备下发。')
    window.setTimeout(() => setNotice(''), 4200)
  }

  const switchToManual = () => {
    setMode('manual')
    setNotice('已切换为手动编排，你可以调整候选 Agent 与迁移模式。')
    window.setTimeout(() => setNotice(''), 3600)
  }

  return (
    <div className="app-shell">
      <TopBar />
      <main className="page-shell">
        <TaskHeader
          paused={paused}
          onTogglePause={() => setPaused(value => !value)}
          onSettings={() => setSettingsOpen(value => !value)}
        />
        <PolicyBar mode={mode} setMode={setMode} settingsOpen={settingsOpen} />
        <div className={canvasClassName}>
          <BusinessTaskPanel />
          <WorkItemsPanel
            expandedPackage={expandedPackage}
            setExpandedPackage={setExpandedPackage}
            handoffConfirmed={handoffConfirmed}
            onOpenHandoff={() => setHandoffOpen(true)}
          />
          <AgentTeamPanel handoffConfirmed={handoffConfirmed} onOpenHandoff={() => setHandoffOpen(true)} />
          <HandoffPanel
            open={handoffOpen}
            onClose={() => setHandoffOpen(false)}
            transferMode={transferMode}
            setTransferMode={setTransferMode}
            selectedCandidates={selectedCandidates}
            toggleCandidate={toggleCandidate}
            onConfirm={confirmHandoff}
            onManual={switchToManual}
            handoffConfirmed={handoffConfirmed}
          />
        </div>
        {!handoffOpen && (
          <button className="floating-handoff" type="button" onClick={() => setHandoffOpen(true)}>
            <Users size={17} /> 查看接力方案 <span>3</span>
          </button>
        )}
      </main>
      {notice && <div className="toast" role="status"><BadgeCheck size={18} /> {notice}</div>}
    </div>
  )
}
