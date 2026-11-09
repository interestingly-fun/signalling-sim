import { Component, type ErrorInfo, type ReactNode } from 'react';

/** Last line of defence: a rendering failure shows a plain message, not a blank page or a stack trace. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Ashcombe Junction display error', error, info.componentStack);
  }
  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="fatal" role="alert">
        <h1>Something went wrong with the display</h1>
        <p>The simulator could not draw the screen. Nothing has been lost from your saved shifts. Reload the page to start again; details are in the browser console.</p>
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    );
  }
}
