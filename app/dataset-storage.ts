import { DATASET_KEY, AuthorDataset, emptyDataset, loadDataset } from "./author-data";

export class DatasetStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DatasetStorageError";
  }
}

export function readDataset(): AuthorDataset {
  try {
    return loadDataset(window.localStorage.getItem(DATASET_KEY));
  } catch (error) {
    throw new DatasetStorageError("Your saved travelogue could not be read.", { cause: error });
  }
}

export function persistDataset(dataset: AuthorDataset) {
  try {
    window.localStorage.setItem(DATASET_KEY, JSON.stringify(dataset));
  } catch (error) {
    throw new DatasetStorageError("Your latest changes could not be saved on this device.", { cause: error });
  }
}

export function clearStoredDataset() {
  try {
    window.localStorage.removeItem(DATASET_KEY);
  } catch (error) {
    throw new DatasetStorageError("Your saved travelogue could not be removed from this device.", { cause: error });
  }
}

export function readDatasetOrEmpty() {
  try {
    return readDataset();
  } catch {
    return emptyDataset();
  }
}
