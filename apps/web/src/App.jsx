import { useMemo, useState } from 'react';

function Message({ message }) {
  return (
    <div className={`message message-${message.role}`}>
      <div className="message-role">{message.role === 'assistant' ? 'Ops Bot' : 'You'}</div>
      <div className="message-text">{message.content}</div>

      {Array.isArray(message.sources) && message.sources.length > 0 ? (
        <div className="message-sources">
          {message.sources.map((source) => (
            <span className="source-chip" key={source.id || source.storeName}>
              {source.storeName}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const history = useMemo(() => {
    return messages
      .filter((message) => message.role === 'user' || message.role === 'assistant')
      .map((message) => ({ role: message.role, content: message.content }));
  }, [messages]);

  async function sendMessage(text) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    setError('');
    setLoading(true);

    const nextMessages = [...messages, { role: 'user', content: trimmed, sources: [] }];
    setMessages(nextMessages);
    setInput('');

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
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(event) {
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

        <div className="messages">
          {messages.map((message, index) => (
            <Message key={`${message.role}-${index}`} message={message} />
          ))}

          {loading ? <div className="loading-row">Thinking…</div> : null}
        </div>

        <form className="composer" onSubmit={handleSubmit}>
          <textarea
            className="composer-input"
            placeholder="Ask a store question…"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={loading}
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
