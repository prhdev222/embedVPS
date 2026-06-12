import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api } from './api';
import './styles.css';

const collections = [
  { id: 'medical_knowledge', label: 'Medical knowledge' },
  { id: 'law_lectures', label: 'Law lectures' },
  { id: 'dhamma_lectures', label: 'Dhamma lectures' },
];

const documentTypes = [
  { id: 'guideline', label: 'Medical guideline', collection: 'medical_knowledge' },
  { id: 'journal', label: 'Journal article', collection: 'medical_knowledge' },
  { id: 'medical_lecture', label: 'Medical lecture', collection: 'medical_knowledge' },
  { id: 'law_lecture', label: 'Law lecture', collection: 'law_lectures' },
  { id: 'dhamma_lecture', label: 'Dhamma lecture', collection: 'dhamma_lectures' },
  { id: 'reference', label: 'Other reference', collection: null },
];

const modes = [
  { id: 'text', step: '01', title: 'Text PDF', description: 'ดึงข้อความโดยตรง', meta: 'เร็วที่สุด · ค่าใช้จ่ายต่ำ' },
];

const initialJobs = [
  { id: 'EMB-2841', filename: 'ESC-Hypertension-Guideline-2024.pdf', collection: 'medical_knowledge', document_type: 'guideline', mode: 'text', status: 'processing', progress: 68, chunks: 184, time: '2 นาทีที่แล้ว' },
  { id: 'EMB-2839', filename: 'Clinical-Journal-Review.pdf', collection: 'medical_knowledge', document_type: 'journal', mode: 'text', status: 'done', progress: 100, chunks: 76, time: '18 นาทีที่แล้ว' },
  { id: 'EMB-2838', filename: 'Contract-Law-Lecture.pdf', collection: 'law_lectures', document_type: 'law_lecture', mode: 'text', status: 'error', progress: 42, chunks: 12, time: '31 นาทีที่แล้ว', error: 'ไม่พบข้อความใน PDF กรุณาใช้ไฟล์ที่เลือกข้อความได้' },
];

const searchResults = [
  { id: 'mock-1', score: 0.94, source: 'ESC-Hypertension-Guideline-2024.pdf', page: 42, text: 'For most adults with hypertension, the recommended initial target is below 140/90 mmHg, with a lower target considered when treatment is well tolerated.' },
  { id: 'mock-2', score: 0.88, source: 'Thai-Clinical-Practice-Guidelines-DM.pdf', page: 117, text: 'Blood pressure should be assessed at every routine visit. Individual treatment goals should consider age, comorbidities, and risk of adverse effects.' },
  { id: 'mock-3', score: 0.81, source: 'Emergency-Care-Protocol.pdf', page: 19, text: 'Urgent evaluation is required for severe blood pressure elevation accompanied by signs of acute target-organ injury.' },
];

function Icon({ name, size = 18 }) {
  const paths = {
    upload: <><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/></>,
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16h16V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></>,
    queue: <><path d="M4 6h16M4 12h16M4 18h10"/><circle cx="18" cy="18" r="2"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    alert: <><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></>,
    database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></>,
    arrow: <><path d="M5 12h14"/><path d="m14 7 5 5-5 5"/></>,
    telegram: <><path d="m21 3-7.5 18-4.2-7.3L3 10.8Z"/><path d="M9.3 13.7 21 3"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Workspace({ user, onLogout }) {
  const [files, setFiles] = useState([]);
  const [collection, setCollection] = useState('medical_knowledge');
  const [documentType, setDocumentType] = useState('guideline');
  const [mode, setMode] = useState('text');
  const [jobs, setJobs] = useState(api.isMock ? initialJobs : []);
  const [jobFilter, setJobFilter] = useState('all');
  const [dragging, setDragging] = useState(false);
  const [query, setQuery] = useState('เป้าหมายความดันโลหิตในผู้ป่วยผู้ใหญ่คือเท่าไร?');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState('');
  const fileInput = useRef(null);

  useEffect(() => {
    if (!api.isMock) {
      const refresh = () => api.jobs().then(data => setJobs(data.items || data.jobs || data)).catch(error => {
        if (error.status === 401) onLogout();
        else setNotice('ไม่สามารถโหลดคิวงานจาก VPS ได้');
      });
      refresh();
      const liveTimer = window.setInterval(refresh, 5000);
      return () => window.clearInterval(liveTimer);
    }
    const timer = window.setInterval(() => {
      setJobs(current => current.map(job => {
        if (job.status !== 'processing') return job;
        const progress = Math.min(100, job.progress + 2);
        return { ...job, progress, chunks: job.chunks + 5, status: progress === 100 ? 'done' : 'processing' };
      }));
    }, 1800);
    return () => window.clearInterval(timer);
  }, [onLogout]);

  const visibleJobs = useMemo(() => jobFilter === 'all' ? jobs : jobs.filter(job => job.status === jobFilter), [jobs, jobFilter]);
  const activeCount = jobs.filter(job => job.status === 'processing' || job.status === 'pending').length;

  function changeCollection(nextCollection) {
    setCollection(nextCollection);
    const currentType = documentTypes.find(item => item.id === documentType);
    if (currentType?.collection && currentType.collection !== nextCollection) {
      const firstType = documentTypes.find(item => item.collection === nextCollection);
      if (firstType) setDocumentType(firstType.id);
    }
  }

  function addFiles(fileList) {
    const accepted = Array.from(fileList).filter(file => /\.(pdf|docx|txt)$/i.test(file.name));
    setFiles(current => [...current, ...accepted.filter(file => !current.some(existing => existing.name === file.name))]);
  }

  async function startEmbedding() {
    if (!files.length) return;
    if (!api.isMock) {
      setUploading(true);
      setNotice('');
      try {
        const data = await api.upload(files, collection, documentType, mode);
        setJobs(current => [...(data.jobs || []), ...current]);
        setFiles([]);
        setJobFilter('all');
      } catch (error) {
        if (error.status === 401) onLogout();
        else setNotice(error.message || 'อัปโหลดไม่สำเร็จ');
      } finally {
        setUploading(false);
      }
      return;
    }
    const created = files.map((file, index) => ({
      id: `EMB-${2842 + index}`,
      filename: file.name,
      collection,
      document_type: documentType,
      mode,
      status: index === 0 && activeCount === 0 ? 'processing' : 'pending',
      progress: 0,
      chunks: 0,
      time: 'เมื่อสักครู่',
    }));
    setJobs(current => [...created, ...current]);
    setFiles([]);
    setJobFilter('all');
  }

  async function runQuery(event) {
    event.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setResults([]);
    if (api.isMock) {
      window.setTimeout(() => {
        setResults(searchResults);
        setSearching(false);
      }, 650);
      return;
    }
    try {
      const data = await api.query(query, collection);
      setResults(data.results || data.points || []);
    } catch (error) {
      if (error.status === 401) onLogout();
      else setNotice(error.message || 'ค้นหาไม่สำเร็จ');
    } finally {
      setSearching(false);
    }
  }

  async function deleteResult(result) {
    if (!window.confirm(`ลบ chunk นี้ออกจาก "${collection}" ?\n\nไฟล์: ${result.source}\nหน้า: ${result.page}`)) return;
    try {
      await api.deletePoint(collection, result.id);
      setResults(current => current.filter(item => item.id !== result.id));
    } catch (error) {
      if (error.status === 401) onLogout();
      else setNotice(error.message || 'ลบไม่สำเร็จ');
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="MedEmbed home">
          <span className="brand-mark"><span /><span /></span>
          <span><strong>MedEmbed</strong><small>KNOWLEDGE WORKSPACE</small></span>
        </a>
        <nav aria-label="Main navigation">
          <a className="active" href="#upload">นำเข้าเอกสาร</a>
          <a href="#queue">คิวงาน <span className="nav-count">{activeCount}</span></a>
          <a href="#query">ทดสอบค้นหา</a>
        </nav>
        <div className="account-area"><div className="system-state"><span className="status-dot" /> {user?.name || 'ระบบพร้อมใช้งาน'}</div><button className="logout-button" onClick={onLogout}>ออกจากระบบ</button></div>
      </header>

      <main id="top">
        <section className="intro" id="upload">
          <div>
            <p className="eyebrow">DOCUMENT INTAKE</p>
            <h1>เพิ่มความรู้ให้<br />Hermes Bot</h1>
          </div>
          <div className="intro-copy">
            <p>อัปโหลด guideline หรือ textbook แล้วระบบจะจัดเก็บ แบ่งเนื้อหา และส่งเข้า vector database โดยอัตโนมัติ</p>
            <div className="flow-line" aria-label="Workflow">
              <span>PDF/DOCX/TXT</span><Icon name="arrow" size={15}/><span>Extract</span><Icon name="arrow" size={15}/><span>Embed</span><Icon name="arrow" size={15}/><span>Ready</span>
            </div>
          </div>
        </section>

        <section className="intake-panel">
          <div className="panel-section file-section">
            <div className="section-heading"><span className="step-number">01</span><div><h2>เลือกเอกสาร</h2><p>รองรับหลายไฟล์ รูปแบบ PDF, DOCX หรือ TXT</p></div></div>
            <button
              className={`dropzone ${dragging ? 'dragging' : ''}`}
              onClick={() => fileInput.current?.click()}
              onDragOver={event => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={event => { event.preventDefault(); setDragging(false); addFiles(event.dataTransfer.files); }}
            >
              <span className="upload-icon"><Icon name="upload" size={24}/></span>
              <strong>ลาก PDF, DOCX หรือ TXT มาวางที่นี่</strong>
              <span>หรือคลิกเพื่อเลือกไฟล์จากเครื่อง</span>
              <small>สูงสุด 100 MB ต่อไฟล์</small>
            </button>
            <input ref={fileInput} type="file" accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain" multiple hidden onChange={event => addFiles(event.target.files)} />
            {files.length > 0 && <div className="selected-files">
              {files.map(file => <div className="selected-file" key={file.name}>
                <span className="file-type">{file.name.toLowerCase().endsWith('.docx') ? 'DOCX' : file.name.toLowerCase().endsWith('.txt') ? 'TXT' : 'PDF'}</span>
                <div><strong>{file.name}</strong><small>{(file.size / 1024 / 1024).toFixed(1)} MB · พร้อมอัปโหลด</small></div>
                <button aria-label={`Remove ${file.name}`} onClick={() => setFiles(current => current.filter(item => item.name !== file.name))}><Icon name="close" size={16}/></button>
              </div>)}
            </div>}
          </div>

          <div className="panel-section settings-section">
            <div className="section-heading"><span className="step-number">02</span><div><h2>กำหนดปลายทาง</h2><p>เลือกคลังและชนิดเอกสาร</p></div></div>
            <label className="field-label" htmlFor="collection">COLLECTION</label>
            <div className="select-wrap"><Icon name="database" size={17}/><select id="collection" value={collection} onChange={event => changeCollection(event.target.value)}>{collections.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><span className="select-chevron">⌄</span></div>
            <label className="field-label" htmlFor="document-type">DOCUMENT TYPE</label>
            <div className="select-wrap"><Icon name="file" size={17}/><select id="document-type" value={documentType} onChange={event => setDocumentType(event.target.value)}>{documentTypes.filter(item => !item.collection || item.collection === collection).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><span className="select-chevron">⌄</span></div>
            <fieldset>
              <legend className="field-label">EMBED MODE</legend>
              <div className="mode-list">
                {modes.map(item => <label className={`mode-option ${mode === item.id ? 'selected' : ''}`} key={item.id}>
                  <input type="radio" name="mode" value={item.id} checked={mode === item.id} onChange={() => setMode(item.id)} />
                  <span className="radio-mark" />
                  <span className="mode-index">{item.step}</span>
                  <span className="mode-copy"><strong>{item.title}</strong><span>{item.description}</span><small>{item.meta}</small></span>
                </label>)}
              </div>
            </fieldset>
          </div>

          <div className="submit-section">
            <div className="telegram-note"><Icon name="telegram" size={18}/><span><strong>Telegram notification</strong><small>ระบบจะแจ้งเตือนเมื่อประมวลผลเสร็จ</small></span><span className="toggle-on"><span /></span></div>
            <button className="primary-button" disabled={!files.length || uploading} onClick={startEmbedding}><span>{uploading ? 'กำลังอัปโหลด...' : `เริ่ม Embed ${files.length ? `${files.length} ไฟล์` : ''}`}</span><Icon name="arrow" size={18}/></button>
          </div>
        </section>
        {notice && <div className="notice" role="alert"><Icon name="alert" size={16}/><span>{notice}</span><button onClick={() => setNotice('')} aria-label="Dismiss"><Icon name="close" size={14}/></button></div>}

        <section className="workspace-section" id="queue">
          <div className="section-title-row"><div><p className="eyebrow">BACKGROUND PROCESSING</p><h2>คิวงาน</h2></div><div className="queue-summary"><span><strong>{jobs.filter(j => j.status === 'processing').length}</strong> กำลังทำงาน</span><span><strong>{jobs.filter(j => j.status === 'pending').length}</strong> รอดำเนินการ</span></div></div>
          <div className="queue-panel">
            <div className="queue-toolbar">
              <div className="filter-tabs">
                {[['all','ทั้งหมด'],['processing','กำลังทำ'],['pending','รอ'],['done','เสร็จแล้ว'],['error','มีปัญหา']].map(([value,label]) => <button key={value} className={jobFilter === value ? 'active' : ''} onClick={() => setJobFilter(value)}>{label}{value === 'all' && <span>{jobs.length}</span>}</button>)}
              </div>
              <span className="auto-refresh"><span className="status-dot" /> อัปเดตอัตโนมัติ</span>
            </div>
            <div className="job-list">
              {visibleJobs.map(job => <article className="job-row" key={job.id}>
                <span className={`job-state ${job.status}`}>
                  {job.status === 'done' ? <Icon name="check" size={17}/> : job.status === 'error' ? <Icon name="alert" size={17}/> : job.status === 'processing' ? <span className="spinner" /> : <Icon name="queue" size={17}/>} 
                </span>
                <div className="job-main"><strong>{job.filename}</strong><div className="job-meta"><span>{job.id}</span><span>{job.collection}</span><span>{documentTypes.find(item => item.id === job.document_type)?.label || job.document_type || 'Reference'}</span><span>{job.time}</span></div>{job.error && <small className="error-message">{job.error}</small>}</div>
                <div className="job-progress">
                  {job.status === 'processing' && <><div className="progress-label"><span>{job.chunks} chunks</span><strong>{job.progress}%</strong></div><div className="progress-track"><span style={{ width: `${job.progress}%` }} /></div></>}
                  {job.status === 'pending' && <span className="status-text pending">กำลังรอ</span>}
                  {job.status === 'done' && <span className="status-text done">{job.chunks} chunks · เสร็จแล้ว</span>}
                  {job.status === 'error' && <button className="retry-button">ลองใหม่</button>}
                </div>
                <button className="row-action" aria-label="Job details"><Icon name="chevron" size={17}/></button>
              </article>)}
              {!visibleJobs.length && <div className="empty-state">ไม่มีงานในสถานะนี้</div>}
            </div>
          </div>
        </section>

        <section className="workspace-section query-section" id="query">
          <div className="section-title-row"><div><p className="eyebrow">RETRIEVAL CHECK</p><h2>ทดสอบค้นหาความรู้</h2></div><p className="section-description">ตรวจสอบว่าเนื้อหาที่ embed แล้วค้นเจอและตอบโจทย์ก่อนนำไปใช้กับ Hermes Bot</p></div>
          <div className="query-layout">
            <form className="query-form" onSubmit={runQuery}>
              <label htmlFor="query-input">คำถามสำหรับทดสอบ</label>
              <textarea id="query-input" value={query} onChange={event => setQuery(event.target.value)} rows="4" placeholder="พิมพ์คำถามที่ต้องการค้นหา..." />
              <div className="query-controls">
                <div><label htmlFor="query-collection">ค้นหาใน</label><select id="query-collection" value={collection} onChange={event => changeCollection(event.target.value)}>{collections.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>
                <button type="submit" disabled={searching || !query.trim()}>{searching ? 'กำลังค้นหา...' : <><Icon name="search" size={17}/> ค้นหา</>}</button>
              </div>
            </form>
            <div className={`results-panel ${results.length ? 'has-results' : ''}`}>
              {searching && <div className="search-loading"><span /><p>กำลังค้นหา vector ที่ใกล้เคียง</p></div>}
              {!searching && !results.length && <div className="results-empty"><span><Icon name="search" size={24}/></span><strong>ผลลัพธ์จะแสดงที่นี่</strong><p>ลองถามคำถามเพื่อทดสอบคุณภาพ<br />ของข้อมูลใน collection</p></div>}
              {!searching && results.length > 0 && <div className="results-list"><div className="results-header"><span>พบ {results.length} ผลลัพธ์</span><small>เรียงตาม similarity score</small></div>{results.map((result, index) => <article key={result.id || result.source + result.page}><div className="result-rank">{String(index + 1).padStart(2, '0')}</div><div><div className="result-source"><strong>{result.source}</strong><span>หน้า {result.page}</span></div><p>{result.text}</p></div><div className="result-meta"><strong className="score">{result.score.toFixed(2)}</strong><button type="button" className="result-delete" title="ลบ chunk นี้" aria-label="ลบ chunk นี้" onClick={() => deleteResult(result)}><Icon name="close" size={14}/></button></div></article>)}</div>}
            </div>
          </div>
        </section>
      </main>

      <footer><span>MedEmbed Workspace · Private medical knowledge infrastructure</span><span><span className="status-dot" /> PocketBase · R2 · Qdrant connected</span></footer>
    </div>
  );
}

function LoginScreen({ onLogin }) {
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function submit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      onLogin(await api.login(password));
    } catch (loginError) {
      setError(loginError.status === 401 ? 'รหัสผ่านไม่ถูกต้อง' : loginError.message);
    } finally {
      setSubmitting(false);
    }
  }

  return <main className="login-page">
    <section className="login-card">
      <div className="login-brand"><span className="brand-mark"><span /><span /></span><div><strong>MedEmbed</strong><small>PRIVATE KNOWLEDGE WORKSPACE</small></div></div>
      <div className="login-copy"><p className="eyebrow">SECURE ACCESS</p><h1>เข้าสู่พื้นที่<br />จัดการความรู้</h1><p>สำหรับนำเข้า guideline และ textbook เข้าสู่ Hermes Bot</p></div>
      <form onSubmit={submit}>
        <label htmlFor="password">รหัสผ่าน</label>
        <input id="password" type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" autoFocus placeholder="กรอกรหัสผ่านของคุณ" />
        {error && <p className="login-error" role="alert">{error}</p>}
        <button type="submit" disabled={submitting || !password.trim()}><span>{submitting ? 'กำลังตรวจสอบ...' : 'เข้าสู่ระบบ'}</span><Icon name="arrow" size={18}/></button>
      </form>
      <div className="login-security"><span className="status-dot" /><span>Session ปลอดภัย · หมดอายุอัตโนมัติใน 12 ชั่วโมง</span></div>
      {api.isMock && <p className="mock-badge">LOCAL MOCK MODE · ใช้รหัสผ่านใดก็ได้</p>}
    </section>
  </main>;
}

function App() {
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    api.session().then(setSession).catch(() => setSession(null));
  }, []);

  async function logout() {
    await api.logout().catch(() => {});
    setSession(null);
  }

  if (session === undefined) return <div className="boot-screen"><span className="spinner" /></div>;
  if (!session?.authenticated) return <LoginScreen onLogin={setSession} />;
  return <Workspace user={session.user} onLogout={logout} />;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
