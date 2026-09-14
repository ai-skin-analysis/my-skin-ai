"""Compatibility entry point for the multi-class training pipeline."""

from train_multiclass import parse_args, train


if __name__ == '__main__':
    try:
        train(parse_args())
    except ValueError as error:
        raise SystemExit(f'Error: {error}')
