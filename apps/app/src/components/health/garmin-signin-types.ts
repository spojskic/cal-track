export interface GarminSignInViewProps {
  /** Called once Garmin is connected (the token is stored and the first sync has been started). */
  onDone: () => void;
}
