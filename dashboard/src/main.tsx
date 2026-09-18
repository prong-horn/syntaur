import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ThemeProvider, initTheme } from './theme';
import { ResourceProvider } from './data/useResource';
import { getDefaultResourceStore } from './data/cache';
import './globals.css';

initTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ResourceProvider store={getDefaultResourceStore()}>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </ResourceProvider>
  </StrictMode>,
);
