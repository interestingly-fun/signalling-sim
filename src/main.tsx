import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from './ui/menu/Shell';
import { ErrorBoundary } from './ui/ErrorBoundary';
import './ui/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <Shell />
    </ErrorBoundary>
  </StrictMode>,
);
