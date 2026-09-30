"use client";

import { FormEvent, useState } from "react";
import { BrainCircuit, LockKeyhole, UserRound } from "lucide-react";

export default function LoginPage() {
  const [username,setUsername] = useState("");
  const [password,setPassword] = useState("");
  const [error,setError] = useState("");
  const [busy,setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError("");
    const res = await fetch("/api/auth/login", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({username,password}),
    });
    if (res.ok) location.href="/";
    else setError("نام کاربری یا رمز عبور صحیح نیست");
    setBusy(false);
  }

  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="login-mark"><BrainCircuit size={24}/></div>
        <div className="login-copy">
          <span className="eyebrow">PROJECT MEMORY SYSTEM</span>
          <h1>PR Brain</h1>
          <p>حافظه ساختاریافته پروژه‌ها، Workflowها، تصمیم‌ها و تغییرات.</p>
        </div>
        <form onSubmit={submit} className="login-form">
          <label>نام کاربری</label>
          <div className="input-with-icon">
            <UserRound size={17}/>
            <input autoFocus autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} placeholder="Username"/>
          </div>
          <label style={{marginTop:12}}>رمز عبور</label>
          <div className="input-with-icon">
            <LockKeyhole size={17}/>
            <input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="••••••••••••"/>
          </div>
          {error && <div className="form-error">{error}</div>}
          <button className="primary-button" disabled={busy}>{busy ? "در حال ورود…" : "ورود به Workspace"}</button>
        </form>
        <div className="login-foot">Self-hosted · Versioned · Searchable</div>
      </section>
    </main>
  );
}
