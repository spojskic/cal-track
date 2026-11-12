// react-native-web ships no TypeScript types. The app imports exactly one unstable export from it:
// unstable_createElement, which renders a real DOM element inside the React Native tree (the web date
// input of BirthdateField). Keep this shim minimal; add the imports the app actually uses.
declare module 'react-native-web' {
  export function unstable_createElement(
    component: string,
    props: Record<string, unknown>,
  ): import('react').ReactElement;
}
