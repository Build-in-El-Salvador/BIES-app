/**
 * The logo screen while the app works out who's signed in: the same as the
 * one in index.html (shown while the code loads), so nothing changes on
 * screen between the two. In the phone app the launch screen covers it until
 * the first page has drawn (utils/launchScreen.js).
 */
const BootSplash = () => (
    <div
        className="boot-splash"
        aria-hidden="true"
        style={{
            // Not `inset`: Safari before 14.1 ignores it (as index.html does).
            position: 'fixed', top: 0, right: 0, bottom: 0, left: 0, zIndex: 999999,
            display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0A192F',
        }}
    >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080" width="120" height="120">
            <path fill="#ff5b00" d="M539.97,0C241.73,0-.03,241.76-.03,540s241.76,540,540,540,540.07-241.76,540.07-540S838.2,0,539.97,0ZM539.97,998.16c-252.99,0-458.17-205.11-458.17-458.17S286.98,81.83,539.97,81.83s458.17,205.11,458.17,458.17-205.11,458.17-458.17,458.17Z" />
            <path fill="#f9f5f4" d="M362.5,219.18h196.15c118.32,0,165.17,61.15,165.17,159.62v15.87c0,72.27-30.17,108.8-77.82,127.86,52.41,19.06,87.35,62.74,87.35,142.14v15.88c0,120.7-46.06,180.27-169.15,180.27h-201.71V219.18ZM546.74,481.25c38.91,0,62.74-11.92,62.74-63.53v-42.89c0-50.82-19.85-61.14-61.95-61.14h-73.06v167.56h72.26ZM550.7,766.33c52.41,0,67.5-15.08,67.5-69.09v-51.62c0-50.82-19.85-69.88-67.5-69.88h-76.23v190.59h76.23Z" />
        </svg>
    </div>
);

export default BootSplash;
