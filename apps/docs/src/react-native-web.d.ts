// react-native-web ships no types; this declares only the server API the prerender reads.
declare module "react-native-web" {
  export const StyleSheet: {
    /** The atomic rules collected so far in this process, for a `<style>` tag in the page head. */
    getSheet(): { id: string; textContent: string };
  };
}
