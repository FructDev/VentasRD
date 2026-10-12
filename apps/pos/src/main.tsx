import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { AppRouter } from './app/router';
import './styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('NATIVE_ROOT_MISSING');
createRoot(root).render(<StrictMode><HashRouter><AppRouter /></HashRouter></StrictMode>);
