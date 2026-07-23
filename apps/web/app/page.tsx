function Header() {
  return (
    <header className="el-topbar">
      <a className="el-brand" href="/">
        <span className="el-brand-mark" aria-hidden="true">E</span>
        Evidence Loop
      </a>
      <nav aria-label="Workspace selection">
        <ul className="el-inline-nav">
          <li><a className="el-nav-link" href="/demo/instructor/index.html">Instructor demo</a></li>
          <li><a className="el-nav-link" href="/demo/learner/index.html">Learner demo</a></li>
        </ul>
      </nav>
    </header>
  );
}

export default function HomePage() {
  return (
    <>
      <a className="el-skip-link" href="#main-content">Skip to main content</a>
      <div className="el-shell">
        <Header />
        <main className="el-main" id="main-content">
          <div className="el-content">
            <section className="el-home-hero" aria-labelledby="welcome-title">
              <div>
                <p className="el-eyebrow">Application foundation</p>
                <h1 id="welcome-title">Make learning evidence visible.</h1>
                <p className="el-lede">
                  This Next.js shell establishes a respectful, keyboard-first workspace foundation for future durable instructor and learner flows.
                </p>
                <p className="el-route-note" style={{ marginTop: "var(--el-space-4)" }}>
                  Live learner records, browser authentication, artifact previews, AI orchestration, and instructor decisions are not connected in this A03 foundation.
                </p>
                <div className="el-cluster" style={{ marginTop: "var(--el-space-5)" }}>
                  <a className="el-button el-button--primary" href="/demo/instructor/index.html">Open instructor demo</a>
                  <a className="el-button" href="/demo/learner/index.html">Open learner demo</a>
                </div>
              </div>
              <aside className="el-card el-card--raised" aria-label="Design commitments">
                <div className="el-placeholder-icon" aria-hidden="true">↗</div>
                <h2 className="el-card__title">A calm starting point</h2>
                <ul className="el-placeholder-list">
                  <li><strong>Visible focus</strong><span>Every keyboard destination has a high-contrast focus treatment.</span></li>
                  <li><strong>Reduced motion</strong><span>Motion is minimized when a person requests it.</span></li>
                  <li><strong>Clear status</strong><span>Text labels accompany color and visual treatment.</span></li>
                </ul>
              </aside>
            </section>
          </div>
        </main>
      </div>
    </>
  );
}
