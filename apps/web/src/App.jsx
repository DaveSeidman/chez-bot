import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function MessageBody({ message }) {
  if (message.role !== 'assistant') {
    return <div className="message-text message-text-plain">{message.content}</div>;
  }

  return (
    <div className="message-text message-text-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} rel="noreferrer" target="_blank" />,
        }}
      >
        {message.content}
      </ReactMarkdown>
    </div>
  );
}

function Message({ message }) {
  return (
    <div className={`message message-${message.role}`}>
      <div className="message-role">{message.role === 'assistant' ? 'Ops Bot' : 'You'}</div>
      <MessageBody message={message} />
    </div>
  );
}

function ChatApp() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const composerRef = useRef(null);
  const messagesRef = useRef(null);

  const history = useMemo(() => {
    return messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({
        role: message.role,
        content: message.content,
        meta: message.meta || null,
      }));
  }, [messages]);

  useEffect(() => {
    composerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!loading) {
      composerRef.current?.focus();
    }
  }, [loading]);

  useEffect(() => {
    const container = messagesRef.current;
    if (!container) return;

    container.scrollTop = container.scrollHeight;
  }, [messages, loading]);

  function focusComposerSoon() {
    requestAnimationFrame(() => {
      composerRef.current?.focus();
    });
  }

  async function sendMessage(text) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    setError('');
    setLoading(true);

    const nextMessages = [...messages, { role: 'user', content: trimmed, sources: [], meta: null }];
    setMessages(nextMessages);
    setInput('');
    focusComposerSoon();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: trimmed,
          history,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Request failed.');
      }

      setMessages((current) => [
        ...current,
        {
          role: 'assistant',
          content: data.answer,
          sources: data.sources || [],
          meta: data.meta || null,
        },
      ]);
    } catch (err) {
      console.error(err);
      setError(err.message || 'Something went wrong.');
      setMessages((current) => [
        ...current,
        {
          role: 'assistant',
          content: 'There was a server error. Check the backend and your API key setup.',
          sources: [],
          meta: null,
        },
      ]);
    } finally {
      setLoading(false);
      focusComposerSoon();
    }
  }

  function handleSubmit(event) {
    event.preventDefault();
    sendMessage(input);
  }

  function handleComposerKeyDown(event) {
    if (event.key !== 'Enter') return;
    if (!event.metaKey && !event.ctrlKey) return;

    event.preventDefault();
    sendMessage(input);
  }

  return (
    <div className="app-shell">
      <main className="chat-area">
        <header className="chat-header">
          <div>
            <h1 className="chat-title">Chez Chrystelle Ops Bot</h1>
            <p className="chat-copy">
              Internal first-line bot for delivery questions. It answers only from the store notes in the repo.
            </p>
          </div>
        </header>

        <div className="messages" ref={messagesRef}>
          {messages.map((message, index) => (
            <Message key={`${message.role}-${index}`} message={message} />
          ))}

          {loading ? <div className="loading-row">Thinking…</div> : null}
        </div>

        <form className="composer" onSubmit={handleSubmit}>
          <textarea
            ref={composerRef}
            className="composer-input"
            placeholder="Ask a store question…"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleComposerKeyDown}
          />

          <div className="composer-footer">
            <button className="send-button" type="submit" disabled={loading || !input.trim()}>
              Send
            </button>
          </div>

          {error ? <div className="error-text">{error}</div> : null}
        </form>
      </main>
    </div>
  );
}

function AdminApp() {
  const [authStatus, setAuthStatus] = useState('checking');
  const [isConfigured, setIsConfigured] = useState(true);
  const [sessionUsername, setSessionUsername] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rawText, setRawText] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [loadingManual, setLoadingManual] = useState(false);
  const [savingManual, setSavingManual] = useState(false);
  const [docsCount, setDocsCount] = useState(0);
  const [updatedAt, setUpdatedAt] = useState('');
  const editorRef = useRef(null);

  useEffect(() => {
    checkSession();
  }, []);

  useEffect(() => {
    if (authStatus === 'authenticated') {
      editorRef.current?.focus();
    }
  }, [authStatus]);

  async function checkSession() {
    try {
      const res = await fetch('/api/admin/session');
      const data = await res.json();

      setIsConfigured(Boolean(data.configured));

      if (data.authenticated) {
        setSessionUsername(data.username || '');
        setAuthStatus('authenticated');
        await loadManual();
      } else {
        setAuthStatus('anonymous');
      }
    } catch (err) {
      console.error(err);
      setErrorMessage('Could not check admin session.');
      setAuthStatus('anonymous');
    }
  }

  async function loadManual() {
    setLoadingManual(true);
    setErrorMessage('');
    setStatusMessage('');

    try {
      const res = await fetch('/api/admin/manual');
      const data = await res.json();

      if (res.status === 401) {
        setAuthStatus('anonymous');
        setSessionUsername('');
        return;
      }

      if (!res.ok) {
        throw new Error(data.error || 'Could not load the manual.');
      }

      setRawText(data.rawText || '');
      setDocsCount(data.docsCount || 0);
      setUpdatedAt(data.updatedAt || '');
    } catch (err) {
      console.error(err);
      setErrorMessage(err.message || 'Could not load the manual.');
    } finally {
      setLoadingManual(false);
    }
  }

  async function handleLogin(event) {
    event.preventDefault();
    setErrorMessage('');
    setStatusMessage('');

    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username,
          password,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Login failed.');
      }

      setSessionUsername(data.username || username);
      setPassword('');
      setAuthStatus('authenticated');
      await loadManual();
    } catch (err) {
      console.error(err);
      setErrorMessage(err.message || 'Login failed.');
    }
  }

  async function handleLogout() {
    setErrorMessage('');
    setStatusMessage('');

    try {
      await fetch('/api/admin/logout', {
        method: 'POST',
      });
    } catch (err) {
      console.error(err);
    }

    setAuthStatus('anonymous');
    setSessionUsername('');
    setUsername('');
    setPassword('');
    setRawText('');
    setDocsCount(0);
    setUpdatedAt('');
  }

  async function handleSave() {
    setErrorMessage('');
    setStatusMessage('');

    try {
      const parsed = JSON.parse(rawText);
      if (!Array.isArray(parsed)) {
        throw new Error('The manual must be a JSON array.');
      }
    } catch (err) {
      setErrorMessage(err.message || 'The JSON is invalid.');
      return;
    }

    setSavingManual(true);

    try {
      const res = await fetch('/api/admin/manual', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          rawText,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Could not save the manual.');
      }

      setRawText(data.rawText || rawText);
      setDocsCount(data.docsCount || 0);
      setUpdatedAt(data.updatedAt || '');
      setStatusMessage('Saved.');
    } catch (err) {
      console.error(err);
      setErrorMessage(err.message || 'Could not save the manual.');
    } finally {
      setSavingManual(false);
    }
  }

  return (
    <div className="app-shell">
      <main className="admin-page">
        <header className="chat-header">
          <div className="admin-header-row">
            <div>
              <h1 className="chat-title">Ops Manual Admin</h1>
              <p className="chat-copy">Add or edit entries in the JSON manual and save them back to disk.</p>
            </div>

            <a className="admin-link" href="/">
              Back to chat
            </a>
          </div>
        </header>

        <section className="admin-panel">
          {authStatus === 'checking' ? <div className="loading-row">Checking admin session…</div> : null}

          {authStatus !== 'checking' && !isConfigured ? (
            <div className="admin-empty-state">
              <h2 className="admin-section-title">Admin is not configured</h2>
              <p className="chat-copy">
                Set `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `ADMIN_SESSION_SECRET` on the server to enable this route.
              </p>
            </div>
          ) : null}

          {authStatus === 'anonymous' && isConfigured ? (
            <form className="admin-login-form" onSubmit={handleLogin}>
              <h2 className="admin-section-title">Sign in</h2>

              <label className="admin-label">
                Username
                <input
                  className="admin-input"
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </label>

              <label className="admin-label">
                Password
                <input
                  className="admin-input"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </label>

              <button className="send-button admin-button" type="submit" disabled={!username || !password}>
                Sign in
              </button>
            </form>
          ) : null}

          {authStatus === 'authenticated' ? (
            <div className="admin-editor">
              <div className="admin-toolbar">
                <div className="admin-meta">
                  <span>Signed in as {sessionUsername || 'admin'}</span>
                  <span>{docsCount ? `${docsCount} entries` : 'No entries loaded'}</span>
                  <span>{updatedAt ? `Updated ${new Date(updatedAt).toLocaleString()}` : 'Not loaded yet'}</span>
                </div>

                <div className="admin-actions">
                  <button className="admin-secondary-button" type="button" onClick={loadManual} disabled={loadingManual || savingManual}>
                    Reload
                  </button>
                  <button className="send-button admin-button" type="button" onClick={handleSave} disabled={loadingManual || savingManual}>
                    {savingManual ? 'Saving…' : 'Save'}
                  </button>
                  <button className="admin-secondary-button" type="button" onClick={handleLogout} disabled={savingManual}>
                    Log out
                  </button>
                </div>
              </div>

              <p className="chat-copy admin-helper-copy">
                This is a raw JSON editor for now, which lays the groundwork for richer add/edit controls later.
              </p>

              <textarea
                ref={editorRef}
                className="admin-textarea"
                value={rawText}
                onChange={(event) => setRawText(event.target.value)}
                spellCheck={false}
              />
            </div>
          ) : null}

          {statusMessage ? <div className="admin-status">{statusMessage}</div> : null}
          {errorMessage ? <div className="error-text">{errorMessage}</div> : null}
        </section>
      </main>
    </div>
  );
}

export default function App() {
  const isAdminRoute = window.location.pathname === '/admin' || window.location.pathname.startsWith('/admin/');
  return isAdminRoute ? <AdminApp /> : <ChatApp />;
}
