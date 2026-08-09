import { useEffect, useState } from 'react';
import { ThemeToggle } from '../components/ThemeToggle.js';
import { readStoredTheme, storeTheme } from '../storage.js';
import { APP_VERSION } from '../version.js';

interface IndexPageProps {
  onNavigateLogin: () => void;
}

/**
 * Landing Page introducing TunnelCode.
 *
 * Serves as the main index (/), featuring project overview, features,
 * quick start CLI commands, terminal preview, and a CTA button to navigate to the pairing/login screen.
 */
export function IndexPage({ onNavigateLogin }: IndexPageProps): React.JSX.Element {
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(() => readStoredTheme() ?? 'dark');

  const displayVersion = APP_VERSION.startsWith('v') ? APP_VERSION : `v${APP_VERSION}`;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  const toggleTheme = (): void => {
    const next = theme === 'light' ? 'dark' : 'light';
    setTheme(next);
    storeTheme(next);
  };

  const copyCommand = (): void => {
    void navigator.clipboard.writeText('npx tunnelcode');
    setCopiedCmd(true);
    setTimeout(() => {
      setCopiedCmd(false);
    }, 2000);
  };

  const scrollToSection =
    (id: string) =>
    (event: React.MouseEvent<HTMLAnchorElement>): void => {
      event.preventDefault();
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };

  return (
    <div className="landing-page">
      {/* Top Header Navigation */}
      <header className="landing-navbar">
        <div className="landing-nav-container">
          <div
            className="landing-brand"
            style={{ cursor: 'pointer' }}
            onClick={(e) => {
              e.preventDefault();
              const el = document.getElementById('hero');
              if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
          >
            <div className="brand-badge">
              <img src="/icon-192.png" alt="TunnelCode" width="24" height="24" />
            </div>
            <span className="brand-name">TunnelCode</span>
            <span className="version-pill">{displayVersion}</span>
          </div>

          <nav className="landing-nav-links">
            <a href="#features" onClick={scrollToSection('features')}>
              Features
            </a>
            <a href="#how-it-works" onClick={scrollToSection('how-it-works')}>
              How It Works
            </a>
            <a href="#cli-setup" onClick={scrollToSection('cli-setup')}>
              CLI Guide
            </a>
          </nav>

          <div className="landing-nav-actions">
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="landing-main">
        <div className="login-bg-glow" />

        {/* Hero Section */}
        <section id="hero" className="hero-section">
          <div className="hero-content">
            <div className="hero-badge">
              <span className="badge-sparkle">✨</span> AI Pair Programming Anywhere
            </div>
            <h1 className="hero-title">
              Bridge Your <span className="gradient-text">Terminal & AI Agent</span> to Any Browser
            </h1>
            <p className="hero-subtitle">
              TunnelCode connects your local terminal AI coding workspace to a responsive web
              client. Inspect live git diffs, converse with your agent, and approve tools remotely
              with end-to-end security.
            </p>

            {/* Quick Start Command */}
            <div className="hero-command-box">
              <div className="command-left">
                <span className="command-prompt">$</span>
                <code className="command-text">npx tunnelcode</code>
              </div>
              <button
                type="button"
                className="copy-btn"
                onClick={copyCommand}
                title="Copy command to clipboard"
              >
                {copiedCmd ? (
                  <span className="copied-text">✓ Copied</span>
                ) : (
                  <>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                    </svg>
                    <span>Copy</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Hero Pairing Call To Action Card */}
          <div className="hero-widget">
            <div className="card landing-cta-card">
              <div className="brand-badge animate-pulse">
                <img src="/icon-192.png" alt="TunnelCode" width="28" height="28" />
              </div>
              <h2>Ready to pair?</h2>
              <p className="muted">
                Run <code>tunnelcode</code> in your terminal and enter your 8-letter code to
                connect.
              </p>
              <button type="button" className="btn-primary btn-hero-cta" onClick={onNavigateLogin}>
                Start Pairing Device →
              </button>
            </div>
          </div>
        </section>

        {/* Features Section */}
        <section id="features" className="landing-section">
          <div className="section-header">
            <span className="section-tag font-mono">CAPABILITIES</span>
            <h2>Why Developers Love TunnelCode</h2>
            <p className="muted">
              Everything you need to interact with your AI agent across devices.
            </p>
          </div>

          <div className="features-grid">
            <div className="feature-card">
              <div className="feature-icon icon-lightning">
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                </svg>
              </div>
              <h3>Instant CLI Pairing</h3>
              <p>
                Pair your local workspace in seconds using an 8-letter code. No static IPs or
                complex tunnel configuration required.
              </p>
            </div>

            <div className="feature-card">
              <div className="feature-icon icon-bot">
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <rect x="3" y="11" width="18" height="10" rx="2"></rect>
                  <circle cx="12" cy="5" r="2"></circle>
                  <path d="M12 7v4"></path>
                  <line x1="8" y1="16" x2="8.01" y2="16"></line>
                  <line x1="16" y1="16" x2="16.01" y2="16"></line>
                </svg>
              </div>
              <h3>Interactive AI Chat</h3>
              <p>
                Stream responses, inspect reasoning steps, switch AI engines, and grant granular
                tool execution permissions live.
              </p>
            </div>

            <div className="feature-card">
              <div className="feature-icon icon-diff">
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                  <polyline points="14 2 14 8 20 8"></polyline>
                  <line x1="9" y1="15" x2="15" y2="15"></line>
                  <line x1="12" y1="12" x2="12" y2="18"></line>
                </svg>
              </div>
              <h3>Live Git Diff Viewer</h3>
              <p>
                Review file modifications and diffs as the AI modifies your code. Track file state
                and revert changes seamlessly.
              </p>
            </div>

            <div className="feature-card">
              <div className="feature-icon icon-shield">
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                </svg>
              </div>
              <h3>Zero-Trust Device Approval</h3>
              <p>
                Connections require terminal-side confirmation matching a unique 4-digit approval
                number. You stay in control.
              </p>
            </div>
          </div>
        </section>

        {/* How It Works Section */}
        <section id="how-it-works" className="landing-section">
          <div className="section-header">
            <span className="section-tag font-mono">WORKFLOW</span>
            <h2>Three Steps to Pair</h2>
            <p className="muted">Simple, secure, and fast setup for your terminal session.</p>
          </div>

          <div className="steps-grid">
            <div className="step-card">
              <div className="step-number">01</div>
              <h3>Run CLI Command</h3>
              <p>
                Execute <code>npx tunnelcode</code> inside your target project directory in
                terminal.
              </p>
            </div>
            <div className="step-card">
              <div className="step-number">02</div>
              <h3>Enter 8-Letter Code</h3>
              <p>Copy the pairing code displayed in your CLI into the web input form.</p>
            </div>
            <div className="step-card">
              <div className="step-number">03</div>
              <h3>Verify & Control</h3>
              <p>
                Confirm the approval number in your terminal and begin AI-assisted remote coding!
              </p>
            </div>
          </div>
        </section>

        {/* Terminal Preview Section */}
        <section id="cli-setup" className="landing-section">
          <div className="section-header">
            <span className="section-tag font-mono">TERMINAL PREVIEW</span>
            <h2>CLI Startup Preview</h2>
            <p className="muted">Here is what your terminal session output looks like.</p>
          </div>

          <div className="terminal-mockup">
            <div className="terminal-mockup-header">
              <div className="terminal-dots">
                <span className="dot dot-red"></span>
                <span className="dot dot-yellow"></span>
                <span className="dot dot-green"></span>
              </div>
              <div className="terminal-title">zsh — tunnelcode</div>
            </div>
            <div className="terminal-mockup-body">
              <p>
                <span className="t-green">➜</span> <span className="t-cyan">~/my-project</span>{' '}
                <span className="t-bold">npx tunnelcode</span>
              </p>
              <p className="t-dim">[TunnelCode {displayVersion}] Initializing device...</p>
              <p className="t-dim">[TunnelCode] Workspace: /Users/dev/my-project</p>
              <p>
                <span className="t-blue">ℹ</span> Pairing Code Generated:{' '}
                <span className="t-code-highlight">ABCDEFGH</span>
              </p>
              <p className="t-dim">[Pairing] Open https://tunnelcode.local in browser</p>
              <p className="t-amber">⌛ Waiting for browser connection request...</p>
              <p>
                <span className="t-green">✔</span> Connection requested! Approval Number:{' '}
                <span className="t-bold t-white">0417</span>
              </p>
              <p className="t-green">✔ Approved! Session established.</p>
            </div>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="landing-footer-container">
          <div className="footer-left">
            <div className="brand-badge small">
              <img src="/icon-192.png" alt="TunnelCode" width="18" height="18" />
            </div>
            <span>TunnelCode &copy; 2026. Empowering Remote AI Pair Programming.</span>
          </div>
          <div className="footer-right">
            <a href="#hero" onClick={scrollToSection('hero')}>
              Back to top
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
