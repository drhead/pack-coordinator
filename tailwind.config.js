/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        "./index.html",
        "./mockup.html",
        "./templates/**/*.{html,js,ts,jsx,tsx,jinja,j2,php}",
        "./static/js/**/*.{js,ts}",
    ],
    theme: {
        extend: {},
    },
    plugins: [],
}