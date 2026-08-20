/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        "./index.html",
        "./mockup.html",
        "./templates/**/*.{html,js,ts,jsx,tsx,jinja,j2,php}",
        "./static/js/**/*.{js,ts}",
    ],
    theme: {
        extend: {
            colors: {
                'e621-green': '#2ec035',
                'e621-yellow': '#ecec26',
                'e621-red': '#e45f5f',
                'e621-safe': '#3e9e49',
                'e621-questionable': 'hsl(50, 100%, 70%)',
            }
        },
    },
    plugins: [],
}