import { Component } from 'react';

export default class ErrorBoundary extends Component {
  state = { failed: false, message: '' };
  static getDerivedStateFromError(err) { return { failed: true, message: String(err?.message || err) }; }
  componentDidCatch(err) { console.error(err); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="container section state-box" role="alert">
        <h1>Something went wrong</h1>
        <p className="text-muted">Please refresh the page and try again.</p>
        {import.meta.env.DEV && <pre className="text-muted" style={{ whiteSpace: 'pre-wrap', textAlign: 'left', maxWidth: '60ch', margin: '1rem auto' }}>Dev details: {this.state.message}</pre>}
        <button className="btn btn--primary" type="button" onClick={() => window.location.reload()}>Reload</button>
      </div>
    );
  }
}
