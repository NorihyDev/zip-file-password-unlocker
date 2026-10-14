import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, ArrowRight, ArrowUpRight, BookOpen, Braces, Check, CheckCheck, ChevronRight, CircleHelp, Clipboard, Clock3, CodeXml, FileArchive, FileKey2, FileText, Fingerprint, Gauge, KeyRound, Layers2, LockKeyhole, LockKeyholeOpen, Plus, RefreshCw, Search, ShieldCheck, Sparkles, Square, Terminal, Upload, X, Zap } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { CHARSETS, countCandidates, DEFAULT_CONFIG, DEFAULT_WORDS } from './lib/candidates'
import type { Method, SearchConfig } from './lib/candidates'
import type { ArchiveInfo } from './lib/archive'
import type { Progress, WorkerResponse } from './lib/protocol'

type Status = 'idle' | 'inspecting' | 'running' | 'extracting' | 'found' | 'exhausted' | 'cancelled' | 'error'
const METHODS: { id: Method; title: string; description: string; icon: LucideIcon; tag?: string }[] = [
  { id: 'dictionary', title: 'Dictionary', description: 'Try a list of likely passwords.', icon: BookOpen, tag: 'START HERE' },
  { id: 'brute', title: 'Brute force', description: 'Explore every combination.', icon: Braces },
  { id: 'hybrid', title: 'Hybrid', description: 'Words, case changes + digits.', icon: Layers2 },
  { id: 'mask', title: 'Pattern', description: 'Fill in the pieces you forgot.', icon: Fingerprint },
  { id: 'known', title: 'Known password', description: 'Remove a password you know.', icon: KeyRound },
]
const ZERO: Progress = { attempted: 0, total: 0, elapsed: 0, rate: 0 }
const number = (n: number) => new Intl.NumberFormat('en').format(Math.round(n))
const bytes = (n: number) => n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`
const duration = (n: number) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(Math.floor(n % 60)).padStart(2, '0')}`

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url; link.download = name; link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export default function App() {
  const [config, setConfig] = useState<SearchConfig>(DEFAULT_CONFIG)
  const [file, setFile] = useState<File | null>(null)
  const [info, setInfo] = useState<ArchiveInfo | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [progress, setProgress] = useState<Progress>(ZERO)
  const [result, setResult] = useState<{ password: string; blob: Blob } | null>(null)
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  const [guide, setGuide] = useState(false)
  const [copied, setCopied] = useState(false)
  const [sampleBusy, setSampleBusy] = useState(false)
  const [wordlistName, setWordlistName] = useState('Starter wordlist')
  const worker = useRef<Worker | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const wordInput = useRef<HTMLInputElement>(null)
  const dialog = useRef<HTMLDialogElement>(null)
  const busy = status === 'running' || status === 'extracting' || status === 'inspecting'
  const activeMethod = METHODS.find(method => method.id === config.method)!
  const estimate = useMemo(() => {
    try { return { total: countCandidates(config), error: '' } }
    catch (error) { return { total: 0, error: (error as Error).message } }
  }, [config])
  useEffect(() => () => worker.current?.terminate(), [])
  useEffect(() => { if (guide) dialog.current?.showModal(); else dialog.current?.close() }, [guide])

  function update(patch: Partial<SearchConfig>) {
    setConfig(previous => ({ ...previous, ...patch }))
    if (status !== 'idle') { setStatus('idle'); setResult(null); setProgress(ZERO); setError('') }
  }

  function setupWorker() {
    worker.current?.terminate()
    const next = new Worker(new URL('./recovery.worker.ts', import.meta.url), { type: 'module' })
    next.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data
      if (message.type === 'ready') { setInfo(message.info); setStatus('idle') }
      if (message.type === 'progress') { setProgress(message); setStatus('running') }
      if (message.type === 'extracting') setStatus('extracting')
      if (message.type === 'found') { setProgress(message); setResult(message); setStatus('found') }
      if (message.type === 'exhausted') { setProgress(message); setStatus('exhausted') }
      if (message.type === 'error') { setError(message.message); setStatus('error') }
    }
    next.onerror = () => { setError('The recovery worker could not run. Reload the page and try again.'); setStatus('error'); next.terminate() }
    worker.current = next
    return next
  }

  function chooseFile(selected?: File) {
    if (!selected || busy) return
    worker.current?.terminate()
    setFile(null); setInfo(null); setResult(null); setProgress(ZERO); setError('')
    if (!selected.name.toLowerCase().endsWith('.zip')) { setError('Choose a .zip file. RAR and 7z archives are not supported.'); setStatus('error'); return }
    setFile(selected); setStatus('inspecting')
    setupWorker().postMessage({ type: 'inspect', file: selected })
  }

  function start() {
    if (!file || !info || busy || estimate.error || !info.encrypted) return
    setProgress({ ...ZERO, total: estimate.total }); setError(''); setResult(null); setStatus('running')
    setupWorker().postMessage({ type: 'start', file, config })
  }

  function clear() {
    worker.current?.terminate(); worker.current = null
    setFile(null); setInfo(null); setResult(null); setStatus('idle'); setProgress(ZERO); setError('')
    if (fileInput.current) fileInput.current.value = ''
  }

  async function loadWords(selected?: File) {
    if (!selected) return
    if (selected.size > 5_000_000) { setError('Choose a wordlist under 5 MB.'); return }
    try { update({ words: await selected.text() }); setWordlistName(selected.name) }
    catch { setError('Unable to read that wordlist. Try a UTF-8 text file.') }
  }

  async function sample() {
    if (busy) return
    setSampleBusy(true)
    try {
      const { BlobWriter, TextReader, ZipWriter } = await import('@zip.js/zip.js')
      const writer = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false })
      await writer.add('welcome.md', new TextReader('# You are in.\n\nRecovered locally with Unseal.\nThe demo password is hello.\n'), { password: 'hello', encryptionStrength: 3 })
      update({ method: 'dictionary', words: DEFAULT_WORDS }); setWordlistName('Starter wordlist')
      chooseFile(new File([await writer.close()], 'hello-unseal.zip', { type: 'application/zip' }))
    } catch { setError('Unable to create the demo archive. Try uploading your own ZIP.'); setStatus('error') }
    finally { setSampleBusy(false) }
  }

  async function copyPassword() {
    if (!result) return
    try { await navigator.clipboard.writeText(result.password); setCopied(true); setTimeout(() => setCopied(false), 2000) }
    catch { setError('Clipboard is unavailable. Select and copy the displayed password.') }
  }

  const percentage = progress.total ? Math.min(100, progress.attempted / progress.total * 100) : 0
  const statusLabel: Record<Status, string> = { idle: info ? 'Ready when you are' : 'Waiting for your ZIP', inspecting: 'Reading archive', running: 'Searching passwords', extracting: 'Verifying & rebuilding', found: 'Password recovered', exhausted: 'Search complete', cancelled: 'Search stopped', error: 'Needs your attention' }

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="./" aria-label="Unseal home"><span className="brand-symbol"><LockKeyholeOpen size={22} strokeWidth={2.3} /></span>unseal<span className="brand-dot">.</span></a>
      <span className="sidebar-label">WORKSPACE</span>
      <nav aria-label="Main navigation">
        <button className="nav-item active" onClick={() => document.getElementById('workspace')?.scrollIntoView({ behavior: 'smooth' })}><FileKey2 size={18} />Password recovery<ChevronRight size={15} /></button>
        <button className="nav-item" onClick={() => setGuide(true)}><BookOpen size={18} />Recovery guide<ArrowUpRight size={14} /></button>
        <a className="nav-item" href="https://github.com/NorihyDev/zip-file-password-unlocker" target="_blank" rel="noreferrer"><CodeXml size={18} />Source code<ArrowUpRight size={14} /></a>
      </nav>
      <div className="sidebar-note"><div className="mini-icon"><ShieldCheck size={20} /></div><h3>Your files. Your device.</h3><p>Recovery happens in your browser. Nothing gets uploaded. Ever.</p><span><span className="green-dot" />100% local processing</span></div>
      <div className="sidebar-footer"><span className="version">v1.0</span><span>Made to open possibilities.</span></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div className="breadcrumbs"><span>Workspace</span><ChevronRight size={14} /><strong>Password recovery</strong></div><span className="local-badge"><span className="green-dot" />Running on your device</span><button className="icon-button help-button" aria-label="Open recovery guide" onClick={() => setGuide(true)}><CircleHelp size={19} /></button></header>
      <main id="workspace">
        <section className="hero">
          <div className="hero-copy"><span className="eyebrow"><span />A FRESH START FOR YOUR FILES</span><h1>Locked out?<br />Let’s open it<span>.</span></h1><p>Forgotten passwords happen. Get back into your ZIP files<br className="desktop-break" /> with a little persistence and the right tools.</p><div className="hero-features"><span><ShieldCheck size={15} />Private by design</span><span><Zap size={15} />No installation</span><span><LockKeyholeOpen size={15} />Free & open source</span></div></div>
          <div className="hero-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><span className="art-plus plus-one">+</span><span className="art-plus plus-two">+</span><div className="archive-art"><div className="archive-tab" /><div className="archive-face"><div className="zip-teeth" /><span>.zip</span><div className="zip-pull" /></div></div><div className="floating-lock"><LockKeyholeOpen size={38} strokeWidth={1.7} /></div><div className="art-label"><span className="green-dot" />POSSIBILITIES, UNLOCKED</div></div>
        </section>
        <div className="workspace-grid">
          <div className="flow-column">
            <section className="panel upload-panel"><div className="section-heading"><div><span className="step">01</span><h2>Add your archive</h2></div><span className="subtle">ZIP files only · up to 100 MB</span></div>
              <input ref={fileInput} type="file" accept=".zip,application/zip" className="visually-hidden" aria-label="Choose ZIP file" onChange={event => { chooseFile(event.target.files?.[0]); event.target.value = '' }} disabled={busy} />
              {!file ? <div className={`drop-zone ${dragging ? 'dragging' : ''}`} onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files[0]) }}>
                <div className="upload-icon"><Upload size={25} strokeWidth={1.6} /></div><h3>Drop your ZIP file here</h3><p>or choose one from your device</p><button className="button button-dark" onClick={() => fileInput.current?.click()} disabled={busy}><Plus size={16} />Browse files</button><span className="drop-footnote"><LockKeyhole size={12} />Your archive never leaves this browser.</span>
              </div> : <div className="selected-file"><div className="selected-file-top"><span className="file-icon"><FileArchive size={30} strokeWidth={1.5} /></span><div className="file-details"><h3 title={file.name}>{file.name}</h3><p>{bytes(file.size)}<span>·</span>{info ? `${info.entries} ${info.entries === 1 ? 'entry' : 'entries'}` : 'Reading archive…'}</p></div><button className="icon-button" aria-label="Remove archive" onClick={clear} disabled={busy}><X size={18} /></button></div>{info && <><div className="file-badges"><span><ShieldCheck size={13} />{info.encryption === 'None' ? 'Not encrypted' : `${info.encryption} encrypted`}</span><span>{bytes(info.expandedSize)} unpacked</span></div><div className="file-preview">{info.filenames.slice(0, 3).map((name, index) => <span key={`${name}-${index}`}><FileText size={12} />{name}</span>)}{info.entries > 3 && <span>+ {info.entries - 3} more</span>}</div>{!info.encrypted && <button className="button button-dark" onClick={() => download(file, file.name)}><ArrowDownToLine size={16} />Download original ZIP</button>}</>}</div>}
              <div className="sample-row"><span>Just looking around?</span><button className="text-button" onClick={sample} disabled={busy || sampleBusy}>{sampleBusy ? 'Creating sample…' : 'Try a sample ZIP'}<ArrowRight size={14} /></button><span className="sample-password">password: hello</span></div>
            </section>
            <section className="panel method-panel"><div className="section-heading"><div><span className="step">02</span><h2>Choose your approach</h2></div><button className="text-button muted" onClick={() => setGuide(true)}>Which method?<CircleHelp size={14} /></button></div>
              <div className="method-grid" role="radiogroup" aria-label="Recovery method">{METHODS.map(({ id, title, description, icon: Icon, tag }) => <button key={id} role="radio" aria-checked={config.method === id} disabled={busy} className={`method-card ${config.method === id ? 'selected' : ''}`} onClick={() => update({ method: id })}><div className="method-card-top"><Icon size={21} strokeWidth={1.7} /><span className="radio-dot">{config.method === id && <Check size={10} strokeWidth={3} />}</span></div><strong>{title}</strong><p>{description}</p>{tag && <span className="method-tag">{tag}</span>}</button>)}</div>
              <div className="config-area"><div className="config-title"><Terminal size={15} /><h3>{activeMethod.title} settings</h3><span>CONFIGURATION</span></div><fieldset disabled={busy}>
                {(config.method === 'dictionary' || config.method === 'hybrid') && <><div className="field-heading"><label htmlFor="wordlist">Your wordlist</label><div><button className="text-button" onClick={() => wordInput.current?.click()} type="button"><Upload size={13} />Import .txt</button><button className="icon-button small" aria-label="Reset starter wordlist" type="button" onClick={() => { update({ words: DEFAULT_WORDS }); setWordlistName('Starter wordlist') }}><RefreshCw size={13} /></button></div></div><input type="file" ref={wordInput} accept=".txt,text/plain" className="visually-hidden" aria-label="Import wordlist" onChange={event => { void loadWords(event.target.files?.[0]); event.target.value = '' }} /><textarea id="wordlist" spellCheck={false} value={config.words} onChange={event => { update({ words: event.target.value }); setWordlistName('Custom wordlist') }} /><div className="input-hint"><span><FileText size={12} />{wordlistName}</span><span>One password per line · UTF-8</span></div>{config.method === 'hybrid' && <div className="inline-field"><label htmlFor="suffix">Numeric suffix length</label><select id="suffix" value={config.suffixDigits} onChange={event => update({ suffixDigits: Number(event.target.value) })}><option value={1}>1 digit · 0–9</option><option value={2}>2 digits · 00–99</option><option value={3}>3 digits · 000–999</option></select><p>Tries original, lowercase, uppercase and capitalized words, then adds fixed-length digits.</p></div>}</>}
                {config.method === 'brute' && <><label>Character set</label><div className="charset-options">{Object.entries(CHARSETS).map(([key, chars]) => <label key={key} className="check-option"><input type="checkbox" checked={Array.from(chars).every(char => config.charset.includes(char))} onChange={event => update({ charset: event.target.checked ? [...new Set(Array.from(config.charset + chars))].join('') : Array.from(config.charset).filter(char => !chars.includes(char)).join('') })} /><span>{key === 'digits' ? 'Numbers 0–9' : key === 'lower' ? 'Lowercase a–z' : key === 'upper' ? 'Uppercase A–Z' : 'Symbols !@#'}</span></label>)}</div><label htmlFor="characters">Custom characters</label><input id="characters" value={config.charset} onChange={event => update({ charset: event.target.value })} spellCheck={false} /><div className="length-fields"><div><label htmlFor="min-length">Minimum length</label><input id="min-length" type="number" min={1} max={12} value={config.minLength} onChange={event => update({ minLength: Number(event.target.value) })} /></div><div><label htmlFor="max-length">Maximum length</label><input id="max-length" type="number" min={1} max={12} value={config.maxLength} onChange={event => update({ maxLength: Number(event.target.value) })} /></div></div><p className="field-note">Shorter passwords first. A small character set makes a big difference.</p></>}
                {config.method === 'mask' && <><label htmlFor="pattern">Password pattern</label><input id="pattern" className="mono" value={config.mask} onChange={event => update({ mask: event.target.value })} spellCheck={false} /><div className="pattern-legend"><span><code>?d</code>0–9</span><span><code>?l</code>a–z</span><span><code>?u</code>A–Z</span><span><code>?s</code>symbols</span><span><code>??</code>literal ?</span></div><p className="field-note">Remember part of it? <code>summer?d?d</code> tries summer00 through summer99. Other characters stay exactly as typed.</p></>}
                {config.method === 'known' && <><label htmlFor="password">Archive password</label><input id="password" type="password" value={config.password} onChange={event => update({ password: event.target.value })} placeholder="Enter the password you already know" autoComplete="off" /><p className="field-note">We’ll verify it and create a new ZIP without password protection.</p></>}
              </fieldset></div>
              {estimate.error && <p className="validation-message" role="alert">{estimate.error}</p>}
              <div className="search-footer"><div><span className="subtle">SEARCH SPACE</span><strong>{estimate.error ? 'Adjust settings' : `${number(estimate.total)} candidates`}</strong></div><span><Gauge size={14} />Up to 5M per search</span></div>
            </section>
          </div>
          <aside className="session-column"><section className="panel session-panel"><div className="session-title"><div><span className="green-dot" /><h2>Recovery session</h2></div><span className="live-label">LOCAL</span></div><div className={`session-visual ${status === 'found' ? 'success' : ''} ${busy ? 'working' : ''}`}><div className="session-orbit" />{status === 'found' ? <LockKeyholeOpen size={33} strokeWidth={1.5} /> : busy ? <Search size={32} strokeWidth={1.5} /> : <LockKeyhole size={31} strokeWidth={1.5} />}</div><h3 className="session-status" role="status">{statusLabel[status]}</h3><p className="session-description">{status === 'found' ? 'A fresh start. Your archive is ready.' : status === 'exhausted' ? 'No match in this search. Try another wordlist or adjust your settings.' : status === 'cancelled' ? 'Your search stopped. Adjust your settings and start again.' : status === 'extracting' ? 'Checking every file and creating your unlocked ZIP.' : status === 'running' ? 'Working through your candidates. Keep this tab open.' : 'Add an archive, choose a method, and let’s get you back in.'}</p>
              <div className="session-stats"><div><span><CheckCheck size={14} />Passwords tried</span><strong>{number(progress.attempted)}</strong></div><div><span><Zap size={14} />Search speed</span><strong>{number(progress.rate)}<small> / sec</small></strong></div><div><span><Clock3 size={14} />Elapsed time</span><strong>{duration(progress.elapsed)}</strong></div></div>
              <div className="progress-label"><span>{status === 'found' ? 'Match found' : 'Search progress'}</span><strong>{percentage > 0 && percentage < 0.1 ? '<0.1' : percentage.toFixed(1)}%</strong></div><div className="progress-track" role="progressbar" aria-label="Search progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percentage}><span style={{ width: `${percentage}%` }} /></div>
              {result && <div className="result-box"><span>RECOVERED PASSWORD</span><div><code>{result.password || '(empty password)'}</code><button className="icon-button" aria-label="Copy recovered password" onClick={copyPassword}>{copied ? <Check size={16} /> : <Clipboard size={16} />}</button></div><button className="button button-dark" onClick={() => download(result.blob, `${file!.name.replace(/\.zip$/i, '')}-unlocked.zip`)}><ArrowDownToLine size={16} />Download unlocked ZIP</button></div>}
              {busy ? <button className="button button-stop" onClick={() => { worker.current?.terminate(); setStatus('cancelled') }}><Square size={13} />{status === 'inspecting' ? 'Stop reading' : 'Stop recovery'}</button> : <button className="button button-lime start-button" onClick={start} disabled={!info?.encrypted || !!estimate.error}><span>{status === 'found' ? 'Run another search' : status === 'exhausted' || status === 'cancelled' ? 'Try again' : 'Start recovery'}</span><ArrowRight size={18} /></button>}
              <p className="session-footnote"><ShieldCheck size={12} />Only recover archives you own or have permission to access.</p>
            </section>
            <section className="tip-card"><span className="tip-icon"><Sparkles size={19} /></span><span className="eyebrow">A LITTLE HEAD START</span><h3>Remember something?</h3><p>A word, a date, a familiar pattern. Even a small clue can turn a long search into a short one.</p><button className="text-button" onClick={() => setGuide(true)}>Find your best approach<ArrowUpRight size={14} /></button></section>
            <div className="compatibility"><span>BUILT FOR THE ARCHIVES YOU USE</span><div><Check size={13} />ZipCrypto<Check size={13} />WinZip AES</div><p>Recovery depends on password complexity.<br />Long, random passwords may be impractical.</p></div>
          </aside>
        </div>
        {error && <div className="error-banner" role="alert"><CircleHelp size={18} /><p>{error}</p><button className="icon-button" aria-label="Dismiss error" onClick={() => setError('')}><X size={17} /></button></div>}
        <footer className="page-footer"><span><LockKeyholeOpen size={14} />A little persistence. A fresh start.</span><button className="text-button muted" onClick={() => setGuide(true)}>How it works<ArrowUpRight size={13} /></button></footer>
      </main>
    </div>
    <dialog ref={dialog} onClose={() => setGuide(false)} className="guide-dialog" onClick={event => { if (event.target === event.currentTarget) setGuide(false) }}><div className="dialog-content"><div className="dialog-heading"><span className="eyebrow">THE RECOVERY GUIDE</span><button className="icon-button" aria-label="Close guide" onClick={() => setGuide(false)}><X size={20} /></button></div><h2>A clue goes a long way<span>.</span></h2><p>ZIP encryption can’t simply be removed without the password. Unseal tries the candidates you choose, then verifies every file before rebuilding the archive.</p><div className="guide-methods">{METHODS.map(({ id, title, icon: Icon }) => <div key={id}><Icon size={21} /><div><h3>{title}</h3><p>{id === 'dictionary' ? 'Best first step. Add passwords you may have used or import your own UTF-8 wordlist. Blank lines and duplicates are skipped; spaces are kept.' : id === 'brute' ? 'Best for short passwords. Try all combinations of your chosen characters, from the minimum to the maximum length.' : id === 'hybrid' ? 'Best for a remembered word. Try case variations and append fixed-width digits, such as Hello07.' : id === 'mask' ? 'Best when you know the structure. Use ?d for a digit, ?l for lowercase, ?u for uppercase, ?s for symbols, and ?? for a question mark.' : 'Already know the password? Verify it once and download a new, unencrypted copy.'}</p></div></div>)}</div><div className="guide-note"><ShieldCheck size={19} /><p>Files, wordlists and passwords stay in memory on your device. Nothing is saved between page reloads. Limits: 100 MB ZIP, 200 MB expanded, 2,000 entries and 5 million candidates. Searches run on one browser worker and can take a long time, especially with AES. Keep the tab open. Archives must use one password for all files.</p></div><button className="button button-dark" onClick={() => setGuide(false)}>Let’s get started<ArrowRight size={16} /></button></div></dialog>
  </div>
}
