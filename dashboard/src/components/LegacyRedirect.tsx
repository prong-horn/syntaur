import { Navigate, useLocation, type To } from 'react-router-dom';
import { resolveLegacyRoute } from '../lib/legacyRoutes';

/** Split a resolved legacy destination into router location fields (hash-safe). */
export function legacyDestinationToLocation(destination: string): To {
  const url = new URL(destination, 'http://legacy.local');
  return { pathname: url.pathname, search: url.search, hash: url.hash };
}

/** Strip `/w/:workspace` with hash-safe object navigation (React Router string `to` can drop fragments). */
export function WorkspacePrefixRedirect() {
  const location = useLocation();
  const stripped = location.pathname.replace(/^\/w\/[^/]+/, '') || '/';
  const target = legacyDestinationToLocation(`${stripped}${location.search}${location.hash}`);
  return <Navigate to={target} replace />;
}

/** Redirect legacy paths to canonical six-page-family routes with replace semantics. */
export function LegacyRedirect() {
  const location = useLocation();
  const { destination } = resolveLegacyRoute(
    location.pathname,
    location.search,
    location.hash,
  );
  if (destination) {
    return <Navigate to={legacyDestinationToLocation(destination)} replace />;
  }
  return null;
}
