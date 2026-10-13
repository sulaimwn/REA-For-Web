'use client';

import { Component, type ReactNode } from 'react';

/** A damaged node should leave a recovery action available in local mode. */
export class ProjectBoundary extends Component<{ children: ReactNode; onReset: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="doc">
        <h1>Couldn’t open this project</h1>
        <p role="alert">Some project details are invalid. Export it again with REA for Web.</p>
        <button type="button" className="btn" onClick={this.props.onReset}>Open another file</button>
      </main>
    );
  }
}
