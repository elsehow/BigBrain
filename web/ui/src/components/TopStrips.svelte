<!-- The strips above the top bar: a newer build (UpdateNudge) and a provider
     out of usage credits (CreditsBanner). FieldView lays the window out
     below them. -->
<script lang="ts">
  import CreditsBanner from "./CreditsBanner.svelte";
  import UpdateNudge from "./UpdateNudge.svelte";
</script>

<div class="strips">
  <UpdateNudge />
  <CreditsBanner />
</div>

<style>
  .strips { flex: none; display: flex; flex-direction: column; }
</style>
